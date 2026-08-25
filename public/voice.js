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

export function createVoiceDialog({ onJournalChanged = () => {}, fetchImplementation = fetch } = {}) {
  const panel = element("section", "voice-panel");
  panel.id = "voice-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Голосовой диалог");

  const head = element("div", "voice-head");
  const status = element("p", "voice-status", "Готов слушать");
  status.id = "voice-status";
  status.setAttribute("role", "status");
  const close = element("button", "voice-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Закрыть диалог");
  head.append(status, close);

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

  panel.append(head, log, form, hint);

  let state = { mode: null, live: null, listening: false, recognition: null };

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
  };

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

  async function runTool(name, args) {
    const response = await fetchImplementation("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { error: payload?.error?.message || "Инструмент не сработал." };
    if (payload.result?.jobId) await waitForJob(payload.result.jobId);
    onJournalChanged();
    return payload.result;
  }

  // ── живой разговор ────────────────────────────────────────────────────────
  async function startLive(session) {
    const connection = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    connection.ontrack = (event) => {
      audio.srcObject = event.streams[0];
    };
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of microphone.getTracks()) connection.addTrack(track, microphone);

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
      setStatus("Слушаю");
      // Инструменты и голос уже заданы при выпуске токена; здесь только
      // подтверждаем их, чтобы сессия точно знала, чем может пользоваться.
      channel.send(JSON.stringify({ type: "session.update", session: { tools: session.tools, tool_choice: "auto" } }));
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const answer = await fetchImplementation(`${SDP_URL}?model=${encodeURIComponent(session.model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!answer.ok) throw new Error("Не удалось соединиться с голосовой моделью.");
    await connection.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    state.live = { connection, channel, microphone, audio };
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
      setStatus("Слушаю");
      return;
    }
    if (payload.type === "conversation.item.input_audio_transcription.completed" && payload.transcript) {
      say("me", payload.transcript.trim());
      return;
    }
    if (payload.type === "response.output_audio_transcript.done" && payload.transcript) {
      say("bot", payload.transcript.trim());
      return;
    }
    if (payload.type === "input_audio_buffer.speech_started") setStatus("Говорите…");
    if (payload.type === "response.created") setStatus("Отвечает");
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
    const socket = new WebSocket(`${session.url}?access_token=${encodeURIComponent(session.clientSecret)}`);
    socket.binaryType = "arraybuffer";
    const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: GEMINI_INPUT_RATE });
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = context.createMediaStreamSource(microphone);
    // Микрофон отдаёт float32, а Live ждёт 16-битный PCM: пересчитываем на лету.
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
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

    const playback = { time: 0 };
    socket.addEventListener("open", () => {
      setStatus("Слушаю");
      // Настройки уже зашиты в токен; здесь только называем модель.
      socket.send(JSON.stringify({ setup: { model: session.model } }));
    });
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
      setStatus("Ошибка соединения");
    });
    socket.addEventListener("close", () => {
      if (state.mode === "live") setStatus("Соединение закрыто");
    });

    state.live = { socket, microphone, context, processor, source, provider: "gemini" };
  }

  async function handleGeminiEvent(payload, socket, context, playback) {
    if (payload.setupComplete) {
      setStatus("Слушаю");
      return;
    }
    if (payload.toolCall?.functionCalls?.length) {
      const responses = [];
      for (const call of payload.toolCall.functionCalls) {
        say("tool", call.name);
        const result = await runTool(call.name, call.args || {});
        responses.push({ name: call.name, id: call.id, response: { result } });
      }
      socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      setStatus("Слушаю");
      return;
    }
    const content = payload.serverContent;
    if (!content) return;
    if (content.inputTranscription?.text) say("me", content.inputTranscription.text.trim());
    if (content.outputTranscription?.text) say("bot", content.outputTranscription.text.trim());
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
      node.connect(context.destination);
      playback.time = Math.max(playback.time, context.currentTime);
      node.start(playback.time);
      playback.time += buffer.duration;
      setStatus("Отвечает");
    }
  }

  // ── разговор без ключа ────────────────────────────────────────────────────
  async function mockTurn(text) {
    setStatus("Думаю");
    const response = await fetchImplementation("/api/voice/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus("Готов слушать");
      say("bot", payload?.error?.message || "Не получилось разобрать реплику.");
      return;
    }
    for (const call of payload.calls || []) say("tool", call.name);
    say("bot", payload.reply);
    speak(payload.reply);
    for (const call of payload.calls || []) if (call.result?.jobId) await waitForJob(call.result.jobId);
    if (payload.calls?.length) onJournalChanged();
    setStatus("Готов слушать");
  }

  function stopListening() {
    state.listening = false;
    listen.setAttribute("aria-pressed", "false");
    try {
      state.recognition?.stop();
    } catch {}
    state.recognition = null;
  }

  listen.addEventListener("click", async () => {
    // В живом режиме микрофон уже слушает модель — вторая запись не нужна.
    if (state.mode === "live") return;
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
    listen.setAttribute("aria-pressed", "true");
    setStatus("Говорите…");
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
    setStatus("Соединяюсь…");
    let session = null;
    try {
      const response = await fetchImplementation("/api/voice/session", { method: "POST" });
      session = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(session?.error?.message || "Голосовая модель недоступна.");
    } catch (error) {
      state.mode = "mock";
      setStatus("Разговор без модели");
      hint.textContent = "Ключа нет: разговор идёт по правилам, но записи настоящие.";
      say("bot", error.message);
      return;
    }
    state.mode = session.mode;
    if (session.mode !== "live") {
      setStatus("Разговор без модели");
      hint.textContent = "Ключа нет: разговор идёт по правилам, но записи настоящие. Добавьте OPENAI_API_KEY — заговорит голосом.";
      return;
    }
    try {
      if (session.provider === "gemini") await startGeminiLive(session);
      else await startLive(session);
      listen.hidden = true;
      hint.textContent = "Говорите вслух — модель отвечает голосом.";
    } catch (error) {
      state.mode = "mock";
      setStatus("Разговор без модели");
      hint.textContent = "Голос недоступен, разговор идёт текстом.";
      say("bot", error.message);
    }
  }

  function stop() {
    panel.hidden = true;
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
      for (const track of state.live.microphone?.getTracks?.() || []) track.stop();
      state.live = null;
    }
    state.mode = null;
    setStatus("Готов слушать");
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
