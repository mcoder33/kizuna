// Голосовой диалог в браузере.
//
// Один и тот же разговор в двух режимах:
//   live — речь в речь: браузер получает короткоживущий токен с сервера и
//          соединяется с Realtime API по WebRTC. Вызовы инструментов уходят на
//          сервер: журнал меняется только там.
//   mock — ключа нет. Реплики набираются текстом (или диктуются, если браузер
//          умеет распознавание) и уходят на /api/voice/turn — тот же набор
//          инструментов, тот же результат в журнале, без сети.
//
// Интерфейс у режимов общий: когда ключ появится, меняется только транспорт.
const SDP_URL = "https://api.openai.com/v1/realtime/calls";

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createVoiceDialog({ onJournalChanged = () => {}, onClosed = () => {}, voiceProvider = () => null, captureProvider = () => null, sleepAfterMs = () => 25000, wakeWord = () => "кизуна", fetchImplementation = fetch } = {}) {
  const panel = element("section", "voice-panel");
  panel.id = "voice-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Голосовой диалог");

  // Шапка разговора: слева выход в журнал, по центру знак, справа настройки и
  // закрытие. В разговоре видно только это — остальной интерфейс скрыт.
  const head = element("div", "voice-head");
  const roundLink = (href, label, icon) => {
    const wrap = element("a", "voice-round-link");
    wrap.href = href;
    const button = element("span", "voice-round");
    button.innerHTML = icon;
    wrap.append(button, element("span", "voice-round-label", label));
    return wrap;
  };
  const CLOCK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.4 4.6v3.9h3.9"/><path d="M12 7.6V12l3 1.8"/></svg>';
  const GEAR_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5H4.4a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4V4.4a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.5 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.5h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9z"/></svg>';
  const brand = element("p", "voice-brand");
  brand.innerHTML =
    '<span class="voice-brand-mark"></span><span class="voice-brand-word">Кизуна</span>';
  const status = element("p", "voice-status", "Готов слушать");
  status.id = "voice-status";
  status.setAttribute("role", "status");
  const close = element("button", "voice-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Закрыть диалог");
  const tail = element("div", "voice-head-tail");
  tail.append(roundLink("#settings", "Настройки", GEAR_ICON), close);
  head.append(roundLink("#reports", "Обзор", CLOCK_ICON), brand, tail, status);

  // Сцена разговора: светящееся кольцо, внутри которого голос виден волнами.
  // Кольцо — кнопка: щелчком разговор усыпляют и будят.
  const stage = element("div", "voice-stage");
  stage.dataset.state = "idle";
  const orb = element("button", "voice-orb");
  orb.type = "button";
  orb.id = "voice-orb";
  // Кольцо собрано из нескольких дуг: они вращаются с разной скоростью и в
  // разные стороны, поэтому свет по ободу всё время перетекает.
  orb.innerHTML =
    '<span class="voice-halo"></span><span class="voice-arc voice-arc-1"></span>' +
    '<span class="voice-arc voice-arc-2"></span><span class="voice-arc voice-arc-3"></span>' +
    '<span class="voice-glass"></span><canvas class="voice-waves" width="520" height="520"></canvas>';
  const waves = orb.querySelector(".voice-waves");
  const phase = element("p", "voice-phase", "");
  phase.id = "voice-phase";
  // Подпись под кольцом — это видимая половина одного и того же состояния;
  // объявляет его скринридеру #voice-status, поэтому здесь role не нужен,
  // иначе состояние читалось бы дважды.
  phase.setAttribute("aria-hidden", "true");
  // Мелкий эквалайзер под подписью: короткий и честный признак того, что
  // микрофон открыт и что-то слышит.
  const meter = element("div", "voice-meter");
  meter.setAttribute("aria-hidden", "true");
  const meterBars = [0, 1, 2, 3, 4, 5, 6].map(() => {
    const bar = element("span", "voice-bar");
    meter.append(bar);
    return bar;
  });
  stage.append(orb, phase, meter);

  const log = element("div", "voice-log");
  log.id = "voice-log";
  log.setAttribute("aria-live", "polite");

  const form = element("form", "voice-say");
  const input = document.createElement("input");
  input.id = "voice-input";
  input.className = "voice-input";
  input.placeholder = "Скажите или напишите…";
  input.setAttribute("aria-label", "Реплика");
  const listen = element("button", "voice-listen");
  listen.type = "button";
  listen.setAttribute("aria-label", "Говорить");
  listen.setAttribute("aria-pressed", "false");
  listen.title = "Говорить";
  listen.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/></svg>';
  const send = element("button", "voice-send", "→");
  send.type = "submit";
  send.setAttribute("aria-label", "Отправить реплику");
  form.append(input, listen, send);

  const hint = element("p", "voice-hint", "");
  hint.id = "voice-hint";

  panel.append(head, stage, log, form, hint);

  let state = {
    mode: null,
    live: null,
    listening: false,
    recognition: null,
    // Разговор спит, пока к нему не обратятся: микрофон выключен, и посторонняя
    // речь до модели не доходит вовсе.
    awake: false,
    phase: "idle",
    sleepTimer: 0,
    wakeWatcher: null,
    meters: null,
    frame: 0,
  };

  // Через столько тишины разговор засыпает сам: человек отвлёкся, а слушать
  // комнату дальше незачем. Значение приходит из настроек приложения.
  const sleepDelay = () => {
    const value = Number(sleepAfterMs());
    return Number.isFinite(value) && value >= 5000 ? value : 25000;
  };
  // Обращение по имени будит разговор. Распознавание местами слышит имя криво,
  // поэтому сравниваем по корню слова, а не по точному совпадению.
  const wakeMatcher = () => {
    const word = String(wakeWord() || "кизуна").trim().toLowerCase();
    // Хвост слова отбрасываем: «кизуна», «кизуну», «кизуной» — одно обращение.
    const root = word.length > 5 ? word.slice(0, word.length - 1) : word;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  };
  // «Спасибо, всё» — вежливый способ закончить, а не новая запись.
  const SLEEP_WORDS = /^(спасибо|хватит|всё|все|пока|отбой|стоп)[.!]?$/i;

  const PHASES = {
    connecting: "Соединяюсь…",
    listening: "Слушаю",
    thinking: "Думаю",
    speaking: "Отвечает",
    sleeping: "Сплю — позовите по имени",
    muted: "Микрофон выключен",
    idle: "Готов слушать",
  };

  // Состояние разговора живёт в одном месте: подпись, класс сцены и заголовок
  // панели меняются вместе, иначе орб и текст расходятся.
  function setPhase(next, text) {
    state.phase = next;
    stage.dataset.state = next;
    const label = text || PHASES[next] || "";
    phase.textContent = label;
    status.textContent = label;
    orb.setAttribute("aria-label", next === "sleeping" ? "Разбудить разговор" : "Усыпить разговор");
    orb.setAttribute("aria-pressed", String(next !== "sleeping"));
  }

  // Без ключа речь узнаёт и озвучивает сам браузер: разговор голосом остаётся
  // разговором, просто думает над ним сервер по правилам, а не модель.
  const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speak = (text) => {
    if (!text || state.mode === "live" || !window.speechSynthesis) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ru-RU";
      window.speechSynthesis.speak(utterance);
    } catch {}
  };

  const say = (who, text) => {
    if (!text) return;
    const line = element("p", `voice-line voice-${who}`, text);
    log.append(line);
    log.scrollTop = log.scrollHeight;
    return line;
  };
  const setStatus = (text) => {
    status.textContent = text;
    phase.textContent = text;
  };

  // ── орб слышит разговор ───────────────────────────────────────────────────
  // Уровень звука — это и есть анимация: кольца дышат от громкости, а не от
  // таймера, поэтому видно, что модель действительно слышит и говорит.
  function createMeter(context, node) {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    node.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    return () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128;
        sum += value * value;
      }
      return Math.sqrt(sum / data.length);
    };
  }

  // Волны внутри кольца рисует голос: тишина — почти прямая линия, речь —
  // переплетение. Три линии с разной частотой и разным направлением бега.
  const WAVE_LINES = [
    { colour: "rgba(126, 154, 224, 0.55)", amplitude: 1, speed: 1, frequency: 2.1 },
    { colour: "rgba(176, 140, 224, 0.45)", amplitude: 0.72, speed: -1.35, frequency: 3.1 },
    { colour: "rgba(126, 198, 226, 0.42)", amplitude: 0.5, speed: 0.72, frequency: 4.3 },
  ];
  function paintWaves(level, time) {
    const context = waves.getContext?.("2d");
    if (!context) return;
    const { width, height } = waves;
    context.clearRect(0, 0, width, height);
    const middle = height / 2;
    const span = width * 0.74;
    const left = (width - span) / 2;
    // Даже в тишине линия живая: она не должна выглядеть выключенной.
    const reach = 14 + level * 86;
    context.lineWidth = 2.4;
    context.lineCap = "round";
    for (const line of WAVE_LINES) {
      context.beginPath();
      for (let x = 0; x <= span; x += 4) {
        const share = x / span;
        // Конверт: у краёв волна сходит на нет, поэтому линия не упирается в
        // обод, а тает внутри кольца.
        const envelope = Math.sin(share * Math.PI);
        const y =
          middle +
          Math.sin(share * line.frequency * Math.PI * 2 + time * line.speed) *
            envelope *
            reach *
            line.amplitude;
        if (x === 0) context.moveTo(left + x, y);
        else context.lineTo(left + x, y);
      }
      context.strokeStyle = line.colour;
      context.stroke();
    }
  }

  function paintMeter(level, time) {
    meterBars.forEach((bar, index) => {
      const offset = Math.sin(time * 3.4 + index * 0.8) * 0.5 + 0.5;
      const height = 6 + level * 28 * (0.35 + 0.65 * offset);
      bar.style.height = `${height.toFixed(1)}px`;
    });
  }

  function watchLevels(meters) {
    state.meters = meters;
    cancelAnimationFrame(state.frame);
    const tick = (now) => {
      let level = 0;
      for (const meter of state.meters || []) {
        try {
          level = Math.max(level, meter());
        } catch {}
      }
      // Порог отсекает шум комнаты: без него кольцо дрожало бы в тишине.
      const audible = state.awake || state.phase === "speaking";
      const shown = audible ? Math.min(1, Math.max(0, (level - 0.02) * 6)) : 0;
      stage.style.setProperty("--voice-level", shown.toFixed(3));
      const time = now / 1000;
      paintWaves(shown, time);
      paintMeter(shown, time);
      state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
  }

  function meterFor(context, source) {
    try {
      return createMeter(context, source);
    } catch {
      return null;
    }
  }

  // ── сон и пробуждение ─────────────────────────────────────────────────────
  // Во сне микрофонная дорожка выключена: посторонний разговор до модели не
  // доходит вовсе — не «модель промолчит», а нечего слушать.
  function microphoneEnabled(on) {
    for (const track of state.live?.microphone?.getAudioTracks?.() || []) track.enabled = on;
  }

  function resetSleepTimer() {
    clearTimeout(state.sleepTimer);
    if (state.mode !== "live" || !state.awake) return;
    state.sleepTimer = setTimeout(sleepConversation, sleepDelay());
  }

  // Имя слушает сам браузер: во сне звук наружу не уходит, поэтому пробуждение
  // должно случиться здесь, а не на стороне модели.
  function startWakeWatcher() {
    if (!SpeechRecognitionApi) return null;
    let recognition;
    try {
      recognition = new SpeechRecognitionApi();
    } catch {
      return null;
    }
    recognition.lang = "ru-RU";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.addEventListener("result", (event) => {
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const said = event.results[index]?.[0]?.transcript || "";
        if (wakeMatcher().test(said)) {
          wakeConversation();
          return;
        }
      }
    });
    // Распознавание само замолкает через паузу — во сне поднимаем его снова.
    recognition.addEventListener("end", () => {
      if (state.wakeWatcher !== recognition || state.awake || state.mode !== "live") return;
      try {
        recognition.start();
      } catch {}
    });
    try {
      recognition.start();
    } catch {
      return null;
    }
    return recognition;
  }

  function stopWakeWatcher() {
    const watcher = state.wakeWatcher;
    state.wakeWatcher = null;
    try {
      watcher?.abort ? watcher.abort() : watcher?.stop?.();
    } catch {}
  }

  function paintListenButton() {
    if (state.mode !== "live") return;
    listen.setAttribute("aria-pressed", String(state.awake));
    const label = state.awake ? "Выключить микрофон" : "Включить микрофон";
    listen.title = label;
    listen.setAttribute("aria-label", label);
  }

  function sleepConversation() {
    clearTimeout(state.sleepTimer);
    if (state.mode !== "live") {
      stopListening();
      state.awake = false;
      setPhase("sleeping");
      return;
    }
    state.awake = false;
    microphoneEnabled(false);
    setPhase("sleeping");
    paintListenButton();
    state.wakeWatcher = startWakeWatcher();
    if (!state.wakeWatcher) setPhase("sleeping", "Сплю — нажмите на круг");
  }

  function wakeConversation() {
    if (state.mode !== "live") {
      state.awake = true;
      setPhase("listening");
      return;
    }
    stopWakeWatcher();
    state.awake = true;
    microphoneEnabled(true);
    setPhase("listening");
    paintListenButton();
    resetSleepTimer();
  }

  // Любая реплика — своя или ответ модели — отодвигает сон. «Спасибо, всё»
  // кончает разговор сразу: это прощание, а не новая запись.
  function noteSpeech(text, who) {
    if (who === "me" && SLEEP_WORDS.test(String(text || "").trim())) {
      sleepConversation();
      return;
    }
    resetSleepTimer();
  }

  orb.addEventListener("click", () => {
    if (state.mode !== "live") {
      listen.click();
      return;
    }
    if (state.awake) sleepConversation();
    else wakeConversation();
  });

  // Инструменты исполняет сервер: журнал меняется в одном месте, а модель
  // получает ровно тот результат, который лёг в базу.
  // Новая запись сначала попадает в очередь разбора: пока модель не разобрала
  // её, на экране ей появиться не в чем. Ждём завершения задания и только
  // потом обновляем списки — иначе человек говорит «записал», а экран пуст.
  async function waitForJob(jobId) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const response = await fetchImplementation(`/api/jobs/${jobId}`);
      if (!response.ok) return null;
      const job = await response.json().catch(() => null);
      if (!job) return null;
      if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async function runToolCall(name, args) {
    // Разбирает сказанное та же модель, что выбрана для записей в шапке.
    const provider = captureProvider();
    const response = await fetchImplementation("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args, ...(provider ? { provider } : {}) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { error: payload?.error?.message || "Инструмент не сработал." };
    return payload.result;
  }

  // В какую колонку журнала легла запись. Разговор занимает весь экран, и
  // журнала за ним не видно — значит, сказать об этом должен сам разговор.
  function columnFor(parsed) {
    if (parsed?.completed) return "Что делал";
    if (["задача", "встреча"].includes(parsed?.type)) return "TODO";
    return "Заметки";
  }

  async function runTool(name, args) {
    const payload = { result: await runToolCall(name, args) };
    if (payload.result?.error) {
      say("done", payload.result.error);
      return payload.result;
    }
    if (payload.result?.jobId) await waitForJob(payload.result.jobId);
    onJournalChanged();
    // Разбор новой записи заканчивается уже после ответа инструмента: пока мы
    // всё равно ждём задание, дочитываем результат разбора и отдаём модели
    // вместе с ним — иначе спрашивать про неясный тип ей будет не из чего.
    if (name === "create_capture" && payload.result?.captureId) {
      const parsed = await runToolCall("read_capture", { captureId: payload.result.captureId });
      if (parsed && !parsed.error) {
        say("done", `Записал в «${columnFor(parsed)}»: ${parsed.summary}`);
        return { ...payload.result, type: parsed.type, completed: parsed.completed, summary: parsed.summary, clarity: parsed.clarity };
      }
      say("done", "Записал");
      return payload.result;
    }
    // Остальные изменения журнала тоже видно: человек должен понимать, что
    // сказанное дошло, не выходя из разговора.
    if (name === "delete_capture") say("done", "Убрал запись — можно вернуть");
    if (name === "restore_capture" && payload.result?.restored) say("done", "Вернул запись");
    if (name === "append_note") say("done", "Дописал к записи");
    if (name === "update_capture" && payload.result?.summary)
      say("done", `Поправил · ${columnFor(payload.result)}: ${payload.result.summary}`);
    return payload.result;
  }

  // ── живой разговор ────────────────────────────────────────────────────────
  async function startLive(session) {
    const connection = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    // Отдельный контекст только для замера громкости: анализатор ничего не
    // воспроизводит, он лишь снимает уровень со своей дорожки.
    let meterContext = null;
    try {
      meterContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch {}
    const meters = [];
    connection.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      if (!meterContext) return;
      try {
        const meter = meterFor(meterContext, meterContext.createMediaStreamSource(event.streams[0]));
        if (meter) meters.push(meter);
      } catch {}
    };
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of microphone.getTracks()) connection.addTrack(track, microphone);
    if (meterContext) {
      try {
        const meter = meterFor(meterContext, meterContext.createMediaStreamSource(microphone));
        if (meter) meters.push(meter);
      } catch {}
    }
    watchLevels(meters);

    const channel = connection.createDataChannel("oai-events");
    channel.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerEvent(payload, channel);
    });
    channel.addEventListener("open", () => {
      // Инструменты и голос уже заданы при выпуске токена; здесь только
      // подтверждаем их, чтобы сессия точно знала, чем может пользоваться.
      // session.type обязателен: без него Realtime API отвечает «Missing
      // required parameter» и объявление инструментов не применяется.
      channel.send(
        JSON.stringify({
          type: "session.update",
          session: { type: "realtime", tools: session.tools, tool_choice: "auto" },
        }),
      );
      wakeConversation();
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const answer = await fetchImplementation(`${SDP_URL}?model=${encodeURIComponent(session.model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!answer.ok) {
      // Провайдер объясняет отказ словами — их и показываем: «модель не
      // поддерживает живой режим» полезнее общего «не удалось соединиться».
      const reason = await answer.text().catch(() => "");
      let message = "";
      try {
        message = JSON.parse(reason)?.error?.message || "";
      } catch {}
      throw new Error(message || "Не удалось соединиться с голосовой моделью.");
    }
    await connection.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    state.live = { connection, channel, microphone, audio, meterContext };
  }

  async function handleServerEvent(payload, channel) {
    if (payload.type === "response.done") {
      for (const item of payload.response?.output || []) {
        if (item.type !== "function_call") continue;
        let args = {};
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {}
        say("tool", `${item.name}`);
        setPhase("thinking");
        const result = await runTool(item.name, args);
        channel.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result ?? {}) },
          }),
        );
        // Результат сам по себе беззвучен: просим модель продолжить вслух.
        channel.send(JSON.stringify({ type: "response.create" }));
      }
      if (state.awake) setPhase("listening");
      return;
    }
    if (payload.type === "conversation.item.input_audio_transcription.completed" && payload.transcript) {
      const said = payload.transcript.trim();
      say("me", said);
      noteSpeech(said, "me");
      return;
    }
    if (payload.type === "response.output_audio_transcript.done" && payload.transcript) {
      const said = payload.transcript.trim();
      say("bot", said);
      noteSpeech(said, "bot");
      if (state.awake) setPhase("listening");
      return;
    }
    if (payload.type === "input_audio_buffer.speech_started") setPhase("listening", "Говорите…");
    if (payload.type === "response.created") setPhase("speaking");
    if (payload.type === "error") {
      setStatus("Ошибка соединения");
      say("bot", payload.error?.message || "Голосовая модель ответила ошибкой.");
    }
  }

  // ── живой разговор через Gemini ───────────────────────────────────────────
  // У Google другой транспорт: вебсокет вместо WebRTC, звук ходит кусками PCM.
  // Инструменты и правила разговора те же — меняется только способ доставки.
  const GEMINI_INPUT_RATE = 16000;
  const GEMINI_OUTPUT_RATE = 24000;

  const encodeBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  };
  const decodeBase64 = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  async function startGeminiLive(session) {
    // Порядок здесь важен: пока ждёшь микрофон, сокет успевает открыться, и
    // повешенный после ожидания слушатель события «open» уже не увидит —
    // разговор молча зависал на «Соединяюсь…». Поэтому сначала контекст и все
    // слушатели, и только потом микрофон.
    const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: GEMINI_INPUT_RATE });
    const outputMix = context.createGain();
    outputMix.connect(context.destination);
    const playback = { time: 0 };
    // Разговор идёт через свой же сервер: он держит сокет к Google, поэтому
    // страна браузера больше ничего не решает. Старый путь — прямой адрес
    // Google — остаётся рабочим, если сервер отдаст его.
    const socket = new WebSocket(session.relay
      ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${session.url}?ticket=${encodeURIComponent(session.clientSecret)}`
      : `${session.url}?access_token=${encodeURIComponent(session.clientSecret)}`);
    socket.binaryType = "arraybuffer";

    const sendSetup = () => {
      // Настройки уже зашиты в токен; здесь только называем модель.
      socket.send(JSON.stringify({ setup: { model: session.model } }));
      wakeConversation();
    };
    socket.addEventListener("open", sendSetup);
    socket.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      await handleGeminiEvent(payload, socket, context, playback);
    });
    socket.addEventListener("error", () => {
      setPhase("idle", "Ошибка соединения");
    });
    socket.addEventListener("close", () => {
      if (state.mode === "live") setPhase("idle", "Соединение закрыто");
    });
    // Сокет мог открыться, пока вешались слушатели: тогда события уже не будет.
    if (socket.readyState === WebSocket.OPEN) sendSetup();

    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = context.createMediaStreamSource(microphone);
    // Микрофон отдаёт float32, а Live ждёт 16-битный PCM: пересчитываем на лету.
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      // Спящий разговор не отправляет ни байта: комнату модель не слышит.
      if (!state.awake) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      socket.send(
        JSON.stringify({
          realtimeInput: { audio: { data: encodeBase64(pcm.buffer), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } },
        }),
      );
    };
    source.connect(processor);
    processor.connect(context.destination);
    // Кольца дышат и от своего голоса, и от голоса модели: два замера на один
    // и тот же контекст.
    watchLevels([meterFor(context, source), meterFor(context, outputMix)].filter(Boolean));

    state.live = { socket, microphone, context, processor, source, outputMix, provider: "gemini" };
    // Микрофон появился уже после пробуждения — включаем дорожку явно.
    microphoneEnabled(state.awake);
  }

  async function handleGeminiEvent(payload, socket, context, playback) {
    if (payload.setupComplete) {
      wakeConversation();
      return;
    }
    if (payload.toolCall?.functionCalls?.length) {
      const responses = [];
      setPhase("thinking");
      for (const call of payload.toolCall.functionCalls) {
        say("tool", call.name);
        const result = await runTool(call.name, call.args || {});
        responses.push({ name: call.name, id: call.id, response: { result } });
      }
      socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      if (state.awake) setPhase("listening");
      return;
    }
    const content = payload.serverContent;
    if (!content) return;
    if (content.inputTranscription?.text) {
      const said = content.inputTranscription.text.trim();
      say("me", said);
      noteSpeech(said, "me");
    }
    if (content.outputTranscription?.text) {
      const said = content.outputTranscription.text.trim();
      say("bot", said);
      noteSpeech(said, "bot");
    }
    for (const part of content.modelTurn?.parts || []) {
      if (!part.inlineData?.data) continue;
      // Звук приходит кусками: складываем их встык, иначе речь будет рваной.
      const bytes = decodeBase64(part.inlineData.data);
      const samples = new Int16Array(bytes.buffer);
      const buffer = context.createBuffer(1, samples.length, GEMINI_OUTPUT_RATE);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 0x8000;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(state.live?.outputMix || context.destination);
      playback.time = Math.max(playback.time, context.currentTime);
      node.start(playback.time);
      playback.time += buffer.duration;
      setPhase("speaking");
    }
  }

  // ── разговор без ключа ────────────────────────────────────────────────────
  async function mockTurn(text) {
    setPhase("thinking");
    const provider = captureProvider();
    const response = await fetchImplementation("/api/voice/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(provider ? { provider } : {}) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setPhase("idle");
      say("bot", payload?.error?.message || "Не получилось разобрать реплику.");
      return;
    }
    for (const call of payload.calls || []) say("tool", call.name);
    say("bot", payload.reply);
    setPhase("speaking");
    speak(payload.reply);
    for (const call of payload.calls || []) if (call.result?.jobId) await waitForJob(call.result.jobId);
    if (payload.calls?.length) onJournalChanged();
    setPhase("idle");
  }

  function stopListening() {
    state.listening = false;
    if (state.mode !== "live") state.awake = false;
    listen.setAttribute("aria-pressed", "false");
    try {
      state.recognition?.stop();
    } catch {}
    state.recognition = null;
  }

  listen.addEventListener("click", async () => {
    // В живом режиме микрофон уже слушает модель: кнопка глушит и включает его,
    // как щелчок по кольцу, а не запускает второе распознавание.
    if (state.mode === "live") {
      if (state.awake) sleepConversation();
      else wakeConversation();
      return;
    }
    if (state.listening) {
      stopListening();
      setStatus("Готов слушать");
      return;
    }
    if (!SpeechRecognitionApi) {
      hint.textContent = "Браузер не умеет распознавать речь — пишите текстом.";
      return;
    }
    const recognition = new SpeechRecognitionApi();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.addEventListener("result", async (event) => {
      const said = event.results?.[0]?.[0]?.transcript?.trim();
      stopListening();
      if (!said) {
        setStatus("Готов слушать");
        return;
      }
      say("me", said);
      await mockTurn(said);
    });
    recognition.addEventListener("error", () => {
      stopListening();
      setStatus("Не расслышал");
    });
    recognition.addEventListener("end", () => {
      if (state.listening) stopListening();
    });
    state.recognition = recognition;
    state.listening = true;
    state.awake = true;
    listen.setAttribute("aria-pressed", "true");
    setPhase("listening", "Говорите…");
    try {
      recognition.start();
    } catch {
      stopListening();
      setStatus("Готов слушать");
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    say("me", text);
    if (state.mode === "live" && state.live?.provider === "gemini") {
      // У Gemini текст идёт тем же потоком, что и речь.
      state.live.socket.send(JSON.stringify({ realtimeInput: { text } }));
      setStatus("Отвечает");
      return;
    }
    if (state.mode === "live" && state.live?.channel?.readyState === "open") {
      // В живом режиме набранная реплика идёт тем же путём, что и речь.
      state.live.channel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      state.live.channel.send(JSON.stringify({ type: "response.create" }));
      setStatus("Отвечает");
      return;
    }
    await mockTurn(text);
  });

  async function open() {
    panel.hidden = false;
    listen.hidden = false;
    input.focus();
    setPhase("connecting");
    // Волны и полоски живут всё время разговора: в режиме заглушки замеров нет,
    // и они просто стоят ровно — это честно.
    watchLevels(state.meters || []);
    let session = null;
    try {
      const chosen = voiceProvider();
      const response = await fetchImplementation("/api/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chosen ? { provider: chosen } : {}),
      });
      session = await response.json().catch(() => ({}));
      // Исчерпанный предел — это не поломка: разговор не начинается, и об этом
      // надо сказать словами, а не уводить в режим заглушки, будто нет ключа.
      if (response.status === 429) {
        setPhase("idle", "Разговор закрыт");
        hint.textContent = session?.error?.message || "Предел разговора исчерпан.";
        say("bot", session?.error?.message || "Предел разговора исчерпан.");
        return;
      }
      if (!response.ok) throw new Error(session?.error?.message || "Голосовая модель недоступна.");
    } catch (error) {
      state.mode = "mock";
      setPhase("idle", "Разговор без модели");
      hint.textContent = "Ключа нет: разговор идёт по правилам, но записи настоящие.";
      say("bot", error.message);
      return;
    }
    // Звук пойдёт мимо сервера, поэтому длительность знает только браузер: её
    // он и сообщит, когда разговор кончится.
    state.voiceSessionId = session.voiceSessionId || null;
    state.startedAt = Date.now();
    state.mode = session.mode;
    if (session.mode !== "live") {
      setPhase("idle", "Разговор без модели");
      hint.textContent = "Ключа нет: разговор идёт по правилам, но записи настоящие. Добавьте OPENAI_API_KEY — заговорит голосом.";
      return;
    }
    try {
      if (session.provider === "gemini") await startGeminiLive(session);
      else await startLive(session);
      // Разговор занимает весь экран: журнал, поле ввода и шапка в это время
      // не нужны — остаётся круг, как в голосовом режиме телефона.
      panel.classList.add("voice-live");
      // Сказанное живёт прямо под кольцом, а не отдельным блоком у поля ввода:
      // в разговоре это подпись к происходящему, а не переписка.
      stage.append(log);
      // Значок микрофона в поле остаётся: в разговоре он глушит и включает
      // микрофон — то же, что щелчок по кольцу.
      paintListenButton();
      // Класс нужен и на html: полосу прокрутки рисует именно он, и без этого
      // «во весь экран» оказывается на четверть дюйма уже экрана.
      document.documentElement.classList.add("voice-live-open");
      document.body.classList.add("voice-live-open");
      hint.textContent = SpeechRecognitionApi
        ? `Говорите вслух. Замолчите — разговор уснёт и перестанет слушать комнату; позовите «${wakeWord()}», и он вернётся.`
        : "Говорите вслух. Замолчите — разговор уснёт; чтобы разбудить, нажмите на круг.";
    } catch (error) {
      state.mode = "mock";
      state.awake = false;
      panel.classList.remove("voice-live");
      document.documentElement.classList.remove("voice-live-open");
      document.body.classList.remove("voice-live-open");
      setPhase("idle", "Разговор без модели");
      hint.textContent = "Голос недоступен, разговор идёт текстом.";
      say("bot", error.message);
    }
  }

  // Разговор кончился — сервер должен узнать, сколько он длился: иначе минуты
  // не попадут в расход, и предел окажется бумажным. Ответ нас не интересует,
  // поэтому ошибка сети здесь ничего не ломает.
  function reportVoiceSession() {
    const sessionId = state.voiceSessionId;
    if (!sessionId) return;
    state.voiceSessionId = null;
    const seconds = Math.max(0, Math.round((Date.now() - (state.startedAt || Date.now())) / 1000));
    const body = JSON.stringify({ seconds });
    // sendBeacon переживает закрытие вкладки, обычный fetch — не всегда.
    try {
      if (navigator.sendBeacon?.(`/api/voice/session/${sessionId}/close`, new Blob([body], { type: "application/json" }))) return;
    } catch {
      // Не отправилось маяком — пробуем обычным запросом.
    }
    fetchImplementation(`/api/voice/session/${sessionId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }
  window.addEventListener("pagehide", reportVoiceSession);

  function stop() {
    reportVoiceSession();
    panel.hidden = true;
    // Панель возвращается к обычному виду: реплики снова живут своим блоком.
    if (log.parentElement === stage) panel.insertBefore(log, form);
    panel.classList.remove("voice-live");
    document.documentElement.classList.remove("voice-live-open");
    document.body.classList.remove("voice-live-open");
    clearTimeout(state.sleepTimer);
    stopWakeWatcher();
    cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.meters = null;
    state.awake = false;
    stage.style.removeProperty("--voice-level");
    stopListening();
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    if (state.live) {
      state.live.channel?.close?.();
      state.live.connection?.close?.();
      state.live.socket?.close?.();
      state.live.processor?.disconnect?.();
      state.live.source?.disconnect?.();
      state.live.context?.close?.();
      state.live.meterContext?.close?.();
      for (const track of state.live.microphone?.getTracks?.() || []) track.stop();
      state.live = null;
    }
    state.mode = null;
    setPhase("idle");
    // Панель закрывают и своим крестиком, и клавишей Esc — кнопка разговора в
    // подвале карточки об этом сама не узнает и осталась бы подсвеченной.
    onClosed();
  }

  close.addEventListener("click", stop);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      stop();
    }
  });

  return {
    element: panel,
    open,
    stop,
    isOpen: () => !panel.hidden,
    mode: () => state.mode,
  };
}
