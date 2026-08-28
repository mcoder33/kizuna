import crypto from 'node:crypto';
import { claimCaptureJob, completeCaptureJob, failCaptureJob, releaseCaptureJob, renewCaptureJobLease, recordUsage } from './db.js';
import { applyUserOverrides } from './classifier.js';

const safeErrorCodes = new Set(['unavailable','busy','timeout','aborted','nonzero','malformed_output','absent_output','oversize_output','schema_invalid','rate_limited','invalid_provider','not_configured']);

export class CaptureJobWorker {
  constructor({ db, ai, leaseMs = 30_000, pollMs = 250, maxConcurrent = 1, shutdownGraceMs = 5_000, now = () => new Date(), audit = () => {} }) {
    this.db = db;
    this.ai = ai;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.maxConcurrent = maxConcurrent;
    this.shutdownGraceMs = shutdownGraceMs;
    this.now = now;
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
    while (this.active.size < this.maxConcurrent) {
      const claim = claimCaptureJob(this.db, { owner:this.owner, leaseToken:crypto.randomUUID(), leaseMs:this.leaseMs, currentTime:this.now().toISOString() });
      if (!claim) break;
      const controller = new AbortController();
      this.report({event:'capture_job_started',jobId:claim.id,provider:claim.selected_provider});
      const work = this.run(claim, controller).finally(() => { this.active.delete(claim.id); this.schedule(0); });
      this.active.set(claim.id, { claim, controller, work });
    }
    this.schedule();
  }

  async run(claim, controller) {
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      if (!renewCaptureJobLease(this.db, claim, { leaseMs:this.leaseMs, currentTime:this.now().toISOString() })) controller.abort();
    }, Math.max(1, Math.floor(this.leaseMs / 2)));
    heartbeat.unref();
    const stopHeartbeat = () => clearInterval(heartbeat);
    controller.signal.addEventListener('abort', stopHeartbeat, { once:true });
    try {
      const result = await this.ai.classify(claim.raw, claim.selected_provider, controller.signal, claim.selected_model || null);
      // Разбор идёт здесь, значит и расход считается здесь: без этого учёт
      // видел бы только записи, сохранённые синхронно.
      try {
        if (result?.usage && result.usedProvider && result.usedProvider !== 'fallback')
          // Хозяин расхода — тот, чью запись разбирали: расход у каждого свой,
          // и безымянная строка не попала бы ни в чей счёт.
          recordUsage(this.db, { provider:result.usedProvider, model:result.model || null, kind:'classify', inputTokens:result.usage.inputTokens, outputTokens:result.usage.outputTokens, costUsd:result.usage.costUsd, userId:claim.user_id ?? null });
      } catch {}
      if (controller.signal.aborted || this.stopping) return;
      // Ручные параметры карточки ввода перекрывают разбор модели.
      if (claim.overrides_json) {
        try { result.classification = applyUserOverrides(result.classification, JSON.parse(claim.overrides_json), this.now()); } catch {}
      }
      if (completeCaptureJob(this.db, claim, result)) this.report({event:'capture_job_succeeded',jobId:claim.id,provider:claim.selected_provider,durationMs:Date.now()-startedAt});
    } catch (error) {
      if (controller.signal.aborted || this.stopping) return;
      const errorCode=safeErrorCodes.has(error?.code) ? error.code : 'unavailable';
      try { if(failCaptureJob(this.db, claim, errorCode)) this.report({event:'capture_job_failed',jobId:claim.id,provider:claim.selected_provider,durationMs:Date.now()-startedAt,errorCode}); } catch {}
    } finally { clearInterval(heartbeat); controller.signal.removeEventListener('abort', stopHeartbeat); }
  }

  wake() {
    if (this.running && !this.stopping) this.schedule(0);
  }

  abort(jobId) {
    this.active.get(jobId)?.controller.abort();
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const { claim, controller } of this.active.values()) {
      releaseCaptureJob(this.db, claim);
      controller.abort();
    }
    const activeWork = Promise.allSettled([...this.active.values()].map(active => active.work));
    let graceTimer;
    await Promise.race([activeWork, new Promise(resolve => { graceTimer = setTimeout(resolve, this.shutdownGraceMs); })]);
    clearTimeout(graceTimer);
  }
}
