import { userTimeZone, captureTimeContext, validTimeContext } from './time-zone.js';
import { userLocale } from './locale.js';
import crypto from 'node:crypto';
import { newTrace, withTrace, errorFields, classificationFields } from './observability.js';
import { claimCaptureJob, completeCaptureJob, failCaptureJob, releaseCaptureJob, renewCaptureJobLease, recordUsage } from './db.js';
import { autoAssign, callFromText } from './circles.js';
import { applyUserOverrides } from './classifier.js';
import { memoryPrompt } from './memory.js';
import { noticeUnclear } from './notifications.js';

const safeErrorCodes = new Set(['unavailable','busy','timeout','aborted','nonzero','malformed_output','absent_output','oversize_output','schema_invalid','rate_limited','invalid_provider','not_configured']);

export class CaptureJobWorker {
  constructor({ db, ai, leaseMs = 30_000, pollMs = 250, maxConcurrent = 1, shutdownGraceMs = 5_000, now = () => new Date(), audit = () => {}, timeZone = 'Europe/Samara', timeZoneFor = null, beforeClassify = null }) {
    this.db = db;
    this.ai = ai;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.maxConcurrent = maxConcurrent;
    this.shutdownGraceMs = shutdownGraceMs;
    this.now = now;
    this.timeZone = timeZone;
    this.timeZoneFor = timeZoneFor;
    this.beforeClassify = beforeClassify;
    this.audit = audit;
    this.owner = crypto.randomUUID();
    this.timer = null;
    this.running = false;
    this.stopping = false;
    this.active = new Map();
  }

  report(event) { try { this.audit(event); } catch {} }

  start() {
    if (this.running || this.stopping) return;
    this.running = true;
    this.schedule(0);
  }

  schedule(delay = this.pollMs) {
    if (!this.running || this.stopping || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, delay);
    this.timer.unref();
  }

  tick() {
    if (!this.running || this.stopping) return;
    try {
    while (this.active.size < this.maxConcurrent) {
      const claim = claimCaptureJob(this.db, { owner:this.owner, leaseToken:crypto.randomUUID(), leaseMs:this.leaseMs, currentTime:this.now().toISOString() });
      if (!claim) break;
      const controller = new AbortController();
      let savedTrace = {}; try { savedTrace = JSON.parse(claim.trace_json || '{}'); } catch {}
      const work = withTrace({ ...newTrace(), ...savedTrace, userId: claim.user_id, captureId: claim.capture_id, jobId: claim.id, source: claim.origin || savedTrace.source || 'api' },
        () => this.run(claim, controller)).finally(() => { this.active.delete(claim.id); this.schedule(0); });
      this.active.set(claim.id, { claim, controller, work });
    }
    } catch (error) { this.report({ event: 'capture_worker_tick_failed', ...errorFields(error) }); }
    this.schedule();
  }

  async run(claim, controller) {
    const startedAt = Date.now();
    this.report({ event: 'capture_job_started', jobId: claim.id, provider: claim.selected_provider, attemptCount: claim.attempt_count,
      queueWaitMs: Math.max(0, this.now().getTime() - Date.parse(claim.created_at)), reclaimed: claim.attempt_count > 1 });
    const heartbeat = setInterval(() => {
      try {
        if (!renewCaptureJobLease(this.db, claim, { leaseMs:this.leaseMs, currentTime:this.now().toISOString() })) controller.abort('lease_lost');
      } catch (error) { this.report({ event: 'capture_heartbeat_failed', ...errorFields(error) }); controller.abort('lease_lost'); }
    }, Math.max(1, Math.floor(this.leaseMs / 2)));
    heartbeat.unref();
    const stopHeartbeat = () => clearInterval(heartbeat);
    controller.signal.addEventListener('abort', stopHeartbeat, { once:true });
    let executionGate = null;
    try {
      let overrides = null;
      try { overrides = JSON.parse(claim.overrides_json || 'null'); } catch {}
      const fallbackZone = typeof this.timeZone === 'function' ? this.timeZone() : this.timeZone;
      const timeContext = validTimeContext(overrides?.timeContext) ? overrides.timeContext : captureTimeContext(this.timeZoneFor ? this.timeZoneFor(claim.user_id) : userTimeZone(this.db, claim.user_id, fallbackZone), this.now());
      // Память хозяина записи уходит в разбор вместе с текстом: поправленное
      // однажды не должно разбираться заново по-старому.
      executionGate = this.beforeClassify ? await this.beforeClassify(claim.user_id, claim.selected_provider) : null;
      const result = await this.ai.classify(claim.raw, executionGate?.provider ?? claim.selected_provider, controller.signal, claim.selected_model || null, memoryPrompt(this.db, { userId: claim.user_id ?? null }), userLocale(this.db, claim.user_id), timeContext);
      if (executionGate?.reason) { result.requestedProvider = executionGate.requestedProvider; result.fallbackReason = executionGate.reason; }
      // Разбор идёт здесь, значит и расход считается здесь: без этого учёт
      // видел бы только записи, сохранённые синхронно.
      try {
        if (result?.usage && result.usedProvider && result.usedProvider !== 'fallback')
          // Хозяин расхода — тот, чью запись разбирали: расход у каждого свой,
          // и безымянная строка не попала бы ни в чей счёт.
          recordUsage(this.db, { provider:result.usedProvider, model:result.model || null, kind:'classify', inputTokens:result.usage.inputTokens, outputTokens:result.usage.outputTokens, costUsd:result.usage.costUsd, userId:claim.user_id ?? null });
      } catch (error) { this.report({ event: 'capture_side_effect_failed', operation: 'usage', ...errorFields(error) }); }
      if (controller.signal.aborted || this.stopping) return;
      // Ручные параметры карточки ввода перекрывают разбор модели.
      if (claim.overrides_json) {
        try { result.classification = applyUserOverrides(result.classification, overrides, new Date(timeContext.referenceAt), timeContext.timeZone); }
        catch (error) { this.report({ event: 'capture_side_effect_failed', operation: 'overrides', ...errorFields(error) }); }
      }
      if (completeCaptureJob(this.db, claim, result, { timeZone: timeContext.timeZone, referenceAt: timeContext.referenceAt, completedAt: this.now().toISOString() })) {
        // Просьба уходит человеку и тогда, когда разбор закончился в фоне:
        // иначе «Ане — прислать смету» из очереди не дошло бы ни до кого.
        // Пересланное из Telegram написал не хозяин журнала: коллега, чьё
        // «сделай отчёт» переслали себе, не должен получить эту просьбу от вас.
        const foreign = claim.origin === 'telegram_forward';
        let assigned = null;
        if (!foreign) try { assigned = autoAssign(this.db, { captureId:claim.capture_id, userId:claim.user_id ?? null, classification:result.classification, raw:claim.raw }); }
        catch (error) { this.report({ event: 'capture_side_effect_failed', operation: 'assignment', ...errorFields(error) }); }
        // «@Аня» в самой записи — тоже призыв: Аня её видит и знает о ней.
        if (!foreign) try { callFromText(this.db, { captureId:claim.capture_id, authorId:claim.user_id ?? null, raw:claim.raw, assigneeId:assigned?.assignee?.id || null }); }
        catch (error) { this.report({ event: 'capture_side_effect_failed', operation: 'mention', ...errorFields(error) }); }
        // Разобрано в фоне, а человек мог уже уйти: неясная запись ждёт его за колокольчиком.
        try { noticeUnclear(this.db, { userId:claim.user_id ?? null, captureId:claim.capture_id, classification:result.classification, raw:claim.raw }); }
        catch (error) { this.report({ event: 'capture_side_effect_failed', operation: 'notice', ...errorFields(error) }); }
        this.report({event:'capture_job_succeeded',jobId:claim.id,provider:claim.selected_provider,usedProvider:result.usedProvider||result.provider,model:result.model,fallbackReason:result.fallbackReason||null,
          durationMs:Date.now()-startedAt,totalMs:Math.max(0,this.now().getTime()-Date.parse(claim.created_at)),...classificationFields(result.classification)});
      } else this.report({ event: 'capture_commit_lost', jobId: claim.id, durationMs: Date.now()-startedAt });
    } catch (error) {
      if (controller.signal.aborted || this.stopping) return;
      const errorCode=safeErrorCodes.has(error?.code) ? error.code : 'unavailable';
      try { if(failCaptureJob(this.db, claim, errorCode)) this.report({event:'capture_job_failed',jobId:claim.id,provider:claim.selected_provider,durationMs:Date.now()-startedAt,...errorFields(error),errorCode}); }
      catch (storageError) { this.report({ event: 'capture_failure_not_saved', jobId: claim.id, ...errorFields(storageError) }); }
    } finally {
      if (controller.signal.aborted || this.stopping) this.report({ event: 'capture_job_aborted', jobId: claim.id, reason: this.stopping ? 'shutdown' : typeof controller.signal.reason === 'string' ? controller.signal.reason : 'aborted', durationMs: Date.now()-startedAt });
      executionGate?.release(); clearInterval(heartbeat); controller.signal.removeEventListener('abort', stopHeartbeat);
    }
  }

  wake() {
    if (this.running && !this.stopping) this.schedule(0);
  }

  abort(jobId) {
    this.active.get(jobId)?.controller.abort('cancelled');
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const { claim, controller } of this.active.values()) {
      releaseCaptureJob(this.db, claim);
      controller.abort('shutdown');
    }
    const activeWork = Promise.allSettled([...this.active.values()].map(active => active.work));
    let graceTimer;
    await Promise.race([activeWork, new Promise(resolve => { graceTimer = setTimeout(resolve, this.shutdownGraceMs); })]);
    clearTimeout(graceTimer);
  }
}
