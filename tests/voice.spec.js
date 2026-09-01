import { test, expect } from "@playwright/test";

// Подставной транспорт живого режима: настоящего ключа нет, поэтому WebRTC и
// ответ OpenAI подменяются, а всё остальное — наш код, сервер и журнал —
// работает по-настоящему. Так проверяется путь, который включится, когда ключ
// появится: токен → соединение → вызов инструмента → результат обратно модели.
const installFakeRealtime = async (page) => {
  await page.addInitScript(() => {
    window.__voiceProbe = { sent: [], sdp: null, channelLabel: null };
    class FakeDataChannel {
      constructor(label) {
        window.__voiceProbe.channelLabel = label;
        this.readyState = "open";
        this.listeners = {};
        // Настоящий канал сам сообщает об открытии — заглушка обязана тоже,
        // иначе приложение не успеет объявить инструменты.
        setTimeout(() => this.emit("open", {}), 0);
      }
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
      }
      send(payload) {
        window.__voiceProbe.sent.push(JSON.parse(payload));
      }
      close() {
        this.readyState = "closed";
      }
      emit(type, event) {
        for (const handler of this.listeners[type] || []) handler(event);
      }
    }
    class FakePeerConnection {
      constructor() {
        this.channel = null;
        window.__voicePeer = this;
      }
      createDataChannel(label) {
        this.channel = new FakeDataChannel(label);
        window.__voiceChannel = this.channel;
        return this.channel;
      }
      addTrack() {}
      async createOffer() {
        return { type: "offer", sdp: "v=0 fake offer" };
      }
      async setLocalDescription(offer) {
        window.__voiceProbe.sdp = offer.sdp;
      }
      async setRemoteDescription() {}
      close() {}
    }
    window.RTCPeerConnection = FakePeerConnection;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
  });

  // Сессия отвечает так, как ответил бы сервер с настоящим ключом.
  await page.route("**/api/voice/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "live",
        clientSecret: "ek_test_secret",
        model: "gpt-realtime",
        tools: [{ type: "function", name: "create_capture" }],
        instructions: "тестовые указания",
      }),
    }),
  );
  // Обмен SDP с OpenAI — единственное, что нельзя провести без ключа.
  await page.route("**/v1/realtime/calls*", (route) =>
    route.fulfill({ status: 200, contentType: "application/sdp", body: "v=0 fake answer" }),
  );
};

test("without a key the dialog still works: the turn goes through tools into the journal", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");

  await page.locator("#capture-voice").click();
  const panel = page.locator("#voice-panel");
  await expect(panel).toBeVisible();
  // Честно сказано, что ключа нет и что записи всё равно настоящие.
  await expect(page.locator("#voice-hint")).toContainText("Ключа нет");

  await page.locator("#voice-input").fill("запиши задачу подготовить отчёт завтра важно");
  await page.locator("#voice-input").press("Enter");

  await expect(panel.locator(".voice-me")).toHaveText("запиши задачу подготовить отчёт завтра важно");
  await expect(panel.locator(".voice-tool")).toHaveText("create_capture");
  await expect(panel.locator(".voice-bot")).toContainText("Записал как дело");

  // Запись действительно легла в журнал с разобранными параметрами.
  const entry = page.locator("#todo .entry").filter({ hasText: "подготовить отчёт" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });
  await expect(entry).toContainText("важно");

  const entries = await (await request.get("/api/entries?limit=5")).json();
  const saved = entries.entries.find((item) => item.raw.includes("подготовить отчёт"));
  expect(saved.interpretation.classification.primaryType).toBe("task");
  expect(saved.interpretation.classification.priority).toBe("high");
});

test("the dialog answers questions about the journal without inventing anything", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const ask = async (text) => {
    await page.locator("#voice-input").fill(text);
    await page.locator("#voice-input").press("Enter");
  };

  // Пустой журнал — пустой ответ, без выдуманных дел.
  await ask("что у меня сегодня");
  await expect(page.locator(".voice-bot").last()).toContainText("записей пока нет");

  await ask("запиши созвон с Даниилом по релизу");
  await expect(page.locator(".voice-bot").last()).toContainText("Записал");

  await ask("найди про Даниила");
  await expect(page.locator(".voice-bot").last()).toContainText("Нашёл");

  await ask("найди про несуществующее слово");
  await expect(page.locator(".voice-bot").last()).toContainText("ничего не нашёл");

  await ask("допиши обсудили сроки");
  await expect(page.locator(".voice-bot").last()).toContainText("Дописал");
});

test("with a key the live path connects, runs the tool and returns the result to the model", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeRealtime(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();

  // Соединение поднялось: канал открыт под именем, которого ждёт OpenAI.
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");
  const probe = await page.evaluate(() => window.__voiceProbe);
  expect(probe.channelLabel).toBe("oai-events");
  expect(probe.sdp).toContain("offer");
  // Первым делом сессии сообщают доступные инструменты.
  expect(probe.sent[0].type).toBe("session.update");
  expect(probe.sent[0].session.tool_choice).toBe("auto");
  // Без session.type Realtime API отвечает «Missing required parameter» и
  // инструменты остаются необъявленными.
  expect(probe.sent[0].session.type).toBe("realtime");

  // Модель просит записать заметку — как это приходит по каналу событий.
  await page.evaluate(() => {
    window.__voiceChannel.emit("message", {
      data: JSON.stringify({
        type: "response.done",
        response: {
          output: [
            {
              type: "function_call",
              name: "create_capture",
              call_id: "call_test_1",
              arguments: JSON.stringify({ text: "созвон по релизу голосом", type: "todo" }),
            },
          ],
        },
      }),
    });
  });

  // Инструмент отработал на сервере, и запись появилась в журнале.
  const entry = page.locator("#todo .entry").filter({ hasText: "созвон по релизу голосом" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Результат вернулся модели ровно тем событием, которое она ждёт, и следом
  // просьба продолжить вслух. Ждём события, а не читаем сразу: между записью в
  // журнал и ответом модели есть ещё один запрос — разбор для подтверждения.
  await expect
    .poll(async () => (await page.evaluate(() => window.__voiceProbe.sent)).at(-1)?.type, {
      timeout: 15000,
    })
    .toBe("response.create");
  const sent = await page.evaluate(() => window.__voiceProbe.sent);
  const output = sent.find((event) => event.item?.type === "function_call_output");
  expect(output.type).toBe("conversation.item.create");
  expect(output.item.call_id).toBe("call_test_1");
  expect(JSON.parse(output.item.output).saved).toBe(true);
});

test("live transcripts appear in the log and errors are shown honestly", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeRealtime(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  await page.evaluate(() => {
    window.__voiceChannel.emit("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "что у меня сегодня",
      }),
    });
    window.__voiceChannel.emit("message", {
      data: JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Сегодня дел нет." }),
    });
  });
  await expect(page.locator(".voice-me").last()).toHaveText("что у меня сегодня");
  await expect(page.locator(".voice-bot").last()).toHaveText("Сегодня дел нет.");

  await page.evaluate(() => {
    window.__voiceChannel.emit("message", {
      data: JSON.stringify({ type: "error", error: { message: "Сессия истекла." } }),
    });
  });
  await expect(page.locator("#voice-status")).toHaveText("Ошибка соединения");
  await expect(page.locator(".voice-bot").last()).toHaveText("Сессия истекла.");
});

test("a broken live connection falls back to the text dialog instead of dying", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeRealtime(page);
  // Обмен SDP не удался — соединиться нечем.
  await page.route("**/v1/realtime/calls*", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/");
  await page.locator("#capture-voice").click();

  await expect(page.locator("#voice-hint")).toContainText("разговор идёт текстом");
  // Разговор продолжается: реплика всё равно доходит до журнала.
  await page.locator("#voice-input").fill("запиши проверить запасной путь");
  await page.locator("#voice-input").press("Enter");
  await expect(page.locator(".voice-bot").last()).toContainText("Записал");
  await expect(page.locator("#todo .entry").filter({ hasText: "запасной путь" }).first()).toBeVisible({ timeout: 15000 });
});

test("closing the dialog releases the microphone and the connection", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeRealtime(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-panel")).toBeVisible();

  await page.locator(".voice-close").click();
  await expect(page.locator("#voice-panel")).toBeHidden();
  const closed = await page.evaluate(() => window.__voiceChannel.readyState);
  expect(closed).toBe("closed");

  // Кнопка разговора показывает состояние панели: закрыли изнутри — она гаснет,
  // иначе значок остаётся подсвеченным при закрытом диалоге и врёт о состоянии.
  await expect(page.locator("#capture-voice")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-panel")).toBeVisible();
  await page.locator("#voice-panel").press("Escape");
  await expect(page.locator("#voice-panel")).toBeHidden();
  await expect(page.locator("#capture-voice")).toHaveAttribute("aria-pressed", "false");
});

test("without a key the browser itself listens and speaks the answer", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  // Подставные распознавание и синтез: настоящий микрофон в тесте не нужен,
  // проверяем свою часть — что услышанное становится репликой, а ответ
  // проговаривается.
  await page.addInitScript(() => {
    window.__spoken = [];
    class FakeRecognition {
      constructor() {
        this.listeners = {};
        window.__recognition = this;
      }
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
      }
      start() {
        window.__recognitionStarted = true;
      }
      stop() {}
      emit(type, event) {
        for (const handler of this.listeners[type] || []) handler(event);
      }
    }
    window.SpeechRecognition = FakeRecognition;
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: (utterance) => window.__spoken.push(utterance.text), cancel() {} },
    });
  });
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const listen = page.locator(".voice-listen");
  await listen.click();
  await expect(listen).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#voice-status")).toHaveText("Говорите…");

  await page.evaluate(() => {
    window.__recognition.emit("result", { results: [[{ transcript: "запиши задачу проверить микрофон" }]] });
  });

  await expect(page.locator(".voice-me").last()).toHaveText("запиши задачу проверить микрофон");
  await expect(page.locator(".voice-bot").last()).toContainText("Записал");
  // Ответ прозвучал, а не только появился текстом.
  const spoken = await page.evaluate(() => window.__spoken);
  expect(spoken.at(-1)).toContain("Записал");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#todo .entry").filter({ hasText: "проверить микрофон" }).first()).toBeVisible({ timeout: 15000 });
});

test("в живом режиме кнопка микрофона глушит разговор, а не слушает второй раз", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  // Микрофон уже открыт для модели, поэтому кнопка в поле не запускает вторую
  // запись: она выключает и включает тот же микрофон — как щелчок по кольцу.
  const listen = page.locator(".voice-listen");
  await expect(listen).toBeVisible();
  await expect(listen).toHaveAttribute("aria-pressed", "true");
  const stage = page.locator(".voice-stage");
  await expect(stage).toHaveAttribute("data-state", "listening");

  await listen.click();
  await expect(stage).toHaveAttribute("data-state", "sleeping");
  await expect(listen).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__micTrack.enabled)).toBe(false);

  await listen.click();
  await expect(stage).toHaveAttribute("data-state", "listening");
  expect(await page.evaluate(() => window.__micTrack.enabled)).toBe(true);
});

// Подставной вебсокет и звук для живого режима Gemini: настоящего ключа нет,
// поэтому транспорт и аудио подменяются, а наш код, сервер и журнал работают
// по-настоящему.
const installFakeGemini = async (page) => {
  await page.addInitScript(() => {
    window.__geminiProbe = { sent: [], url: null, closed: false };
    class FakeSocket {
      constructor(url) {
        window.__geminiProbe.url = url;
        window.__geminiSocket = this;
        this.readyState = 1;
        this.listeners = {};
        setTimeout(() => this.emit("open", {}), 0);
      }
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
      }
      send(payload) {
        window.__geminiProbe.sent.push(JSON.parse(payload));
      }
      close() {
        this.readyState = 3;
        window.__geminiProbe.closed = true;
      }
      emit(type, event) {
        for (const handler of this.listeners[type] || []) handler(event);
      }
    }
    FakeSocket.OPEN = 1;
    window.WebSocket = FakeSocket;
    // Звук в тесте не нужен: важно, что микрофон открывается и отпускается.
    window.AudioContext = class {
      constructor() {
        this.currentTime = 0;
        this.destination = {};
        window.__audioContext = this;
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      // Смеситель и анализатор нужны кругу разговора: он дышит от громкости.
      createGain() {
        return { connect() {}, disconnect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 16,
          connect() {},
          disconnect() {},
          getByteTimeDomainData(data) {
            data.fill(128);
          },
        };
      }
      createScriptProcessor() {
        // Тест сам «подаёт звук» в этот узел: так проверяется, уходит ли он
        // наружу во сне.
        window.__processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        return window.__processor;
      }
      createBuffer(channels, length) {
        return { duration: length / 24000, getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      close() {
        window.__audioClosed = true;
      }
    };
    // Имя во сне слушает браузер — подставляем распознавание, чтобы «услышать»
    // нужную фразу в тесте, а не ждать настоящего микрофона.
    class FakeRecognition {
      constructor() {
        this.listeners = {};
        window.__speech = this;
      }
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
      }
      start() {
        window.__speechStarted = (window.__speechStarted || 0) + 1;
      }
      stop() {}
      abort() {
        window.__speechAborted = true;
      }
      hear(text) {
        for (const handler of this.listeners.result || [])
          handler({ resultIndex: 0, results: [[{ transcript: text }]] });
      }
    }
    window.SpeechRecognition = FakeRecognition;
    window.__micTrack = { enabled: true, kind: "audio", stop() { window.__micStopped = true; } };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [window.__micTrack],
          getAudioTracks: () => [window.__micTrack],
        }),
      },
    });
  });
  await page.route("**/api/voice/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "live",
        provider: "gemini",
        clientSecret: "auth_tokens/test",
        model: "models/gemini-3.1-flash-live-preview",
        url: "wss://generativelanguage.googleapis.com/ws/test",
        tools: [{ type: "function", name: "create_capture" }],
      }),
    }),
  );
};

test("gemini live connects over a socket, runs the tool and answers back", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  // Токен уходит в адресе — единственный способ, который принимает Google.
  const probe = await page.evaluate(() => window.__geminiProbe);
  expect(probe.url).toContain("wss://generativelanguage.googleapis.com/ws/test");
  expect(probe.url).toContain("access_token=auth_tokens%2Ftest");
  // Первым сообщением идёт setup с моделью.
  expect(probe.sent[0].setup.model).toBe("models/gemini-3.1-flash-live-preview");

  // Модель просит записать — приходит toolCall.
  await page.evaluate(() => {
    window.__geminiSocket.emit("message", {
      data: JSON.stringify({
        toolCall: {
          functionCalls: [
            { name: "create_capture", id: "fc_1", args: { text: "созвон голосом через gemini", type: "todo" } },
          ],
        },
      }),
    });
  });

  const entry = page.locator("#todo .entry").filter({ hasText: "созвон голосом через gemini" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Результат вернулся тем сообщением, которое ждёт Google. Ждём его, а не
  // читаем сразу: между записью в журнал и ответом модели есть ещё один
  // запрос — разбор для подтверждения на экране.
  await expect
    .poll(async () => (await page.evaluate(() => window.__geminiProbe.sent)).some((event) => event.toolResponse), {
      timeout: 15000,
    })
    .toBe(true);
  const sent = await page.evaluate(() => window.__geminiProbe.sent);
  const answer = sent.find((event) => event.toolResponse);
  expect(answer.toolResponse.functionResponses[0].id).toBe("fc_1");
  expect(answer.toolResponse.functionResponses[0].name).toBe("create_capture");
  expect(answer.toolResponse.functionResponses[0].response.result.saved).toBe(true);
});

test("gemini transcripts land in the log and text goes through the same stream", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  await page.evaluate(() => {
    window.__geminiSocket.emit("message", {
      data: JSON.stringify({
        serverContent: {
          inputTranscription: { text: "что у меня сегодня" },
          outputTranscription: { text: "Сегодня дел нет." },
        },
      }),
    });
  });
  await expect(page.locator(".voice-me").last()).toHaveText("что у меня сегодня");
  await expect(page.locator(".voice-bot").last()).toHaveText("Сегодня дел нет.");

  // Набранная реплика уходит тем же потоком, что и речь.
  await page.locator("#voice-input").fill("привет");
  await page.locator("#voice-input").press("Enter");
  const sent = await page.evaluate(() => window.__geminiProbe.sent);
  expect(sent.at(-1).realtimeInput.text).toBe("привет");
});

test("closing a gemini dialog releases the socket, the microphone and the audio context", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  await page.locator(".voice-close").click();
  await expect(page.locator("#voice-panel")).toBeHidden();
  const released = await page.evaluate(() => ({
    socket: window.__geminiProbe.closed,
    microphone: window.__micStopped === true,
    audio: window.__audioClosed === true,
  }));
  expect(released).toEqual({ socket: true, microphone: true, audio: true });
});

test("живой разговор занимает весь экран и оставляет один круг", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const panel = page.locator("#voice-panel");
  await expect(panel).toHaveClass(/voice-live/);
  await expect(page.locator("body")).toHaveClass(/voice-live-open/);

  // Панель занимает окно целиком, и в его середине — круг разговора, а не
  // журнал: во время разговора интерфейса за ним не видно. Ждём конца входной
  // анимации: пока она идёт, панель ужата масштабом и меряется меньше окна.
  await panel.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const viewport = page.viewportSize();
  const box = await panel.boundingBox();
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(viewport.width);
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(viewport.height);
  const middle = await page.evaluate(() =>
    document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("#voice-panel") ? "разговор" : "страница",
  );
  expect(middle).toBe("разговор");

  const orb = await page.locator("#voice-orb").boundingBox();
  expect(orb.width).toBeGreaterThan(180);
  expect(Math.round(orb.width)).toBe(Math.round(orb.height));

  // Закрытие возвращает страницу как была.
  await page.locator(".voice-close").click();
  await expect(panel).not.toHaveClass(/voice-live/);
  await expect(page.locator("body")).not.toHaveClass(/voice-live-open/);
});

test("разговор засыпает, не слушает комнату и просыпается по имени", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const stage = page.locator(".voice-stage");
  await expect(stage).toHaveAttribute("data-state", "listening");
  expect(await page.evaluate(() => window.__micTrack.enabled)).toBe(true);

  // Звук бодрствующего разговора уходит модели.
  const speak = () =>
    page.evaluate(() =>
      window.__processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(128) } }),
    );
  const audioSent = () =>
    page.evaluate(() => window.__geminiProbe.sent.filter((event) => event.realtimeInput?.audio).length);
  await speak();
  expect(await audioSent()).toBeGreaterThan(0);

  // Уснул: дорожка микрофона выключена, и комната наружу не уходит вовсе.
  await page.locator("#voice-orb").click();
  await expect(stage).toHaveAttribute("data-state", "sleeping");
  expect(await page.evaluate(() => window.__micTrack.enabled)).toBe(false);
  const before = await audioSent();
  await speak();
  await speak();
  expect(await audioSent()).toBe(before);

  // Чужая речь во сне не будит…
  await page.evaluate(() => window.__speech.hear("вообще-то мы вчера обсуждали отпуск"));
  await expect(stage).toHaveAttribute("data-state", "sleeping");
  // …а обращение по имени — будит, и звук снова идёт.
  await page.evaluate(() => window.__speech.hear("Кизуна, запиши мысль"));
  await expect(stage).toHaveAttribute("data-state", "listening");
  expect(await page.evaluate(() => window.__micTrack.enabled)).toBe(true);
  await speak();
  expect(await audioSent()).toBeGreaterThan(before);
});

test("голосом можно удалить запись и вернуть её обратно", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const say = async (text) => {
    await page.locator("#voice-input").fill(text);
    await page.locator("#voice-input").press("Enter");
  };
  await say("запиши задачу зайти к стоматологу");
  const entry = page.locator("#todo .entry").filter({ hasText: "стоматологу" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  await say("удали последнюю запись");
  await expect(page.locator(".voice-bot").last()).toContainText("Убрал");
  await expect(entry).toHaveCount(0);

  await say("верни");
  await expect(page.locator(".voice-bot").last()).toContainText("Вернул");
  await expect(page.locator("#todo .entry").filter({ hasText: "стоматологу" }).first()).toBeVisible({
    timeout: 15000,
  });
});

test("неясный тип записи разговор переспрашивает, а не выдумывает", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  await page.locator("#capture-voice").click();

  await page.locator("#voice-input").fill("пересмотреть план недели");
  await page.locator("#voice-input").press("Enter");
  await expect(page.locator(".voice-bot").last()).toContainText("Это дело, заметка или результат?");

  // Ответ одним словом ложится на ту же запись, а новой не создаёт.
  await expect(page.locator("#today .entry").filter({ hasText: "план недели" }).first()).toBeVisible({
    timeout: 15000,
  });
  await page.locator("#voice-input").fill("заметка");
  await page.locator("#voice-input").press("Enter");
  await expect(page.locator(".voice-bot").last()).toContainText("Теперь это заметка");
  const entries = await (await request.get("/api/entries?limit=10")).json();
  expect(entries.entries.filter((item) => item.raw.includes("план недели"))).toHaveLength(1);
});

// Выбор провайдера голоса живёт в шапке и показывается только тогда, когда
// ключей действительно два: с одним выбирать нечего.
test("выбор провайдера голоса появляется при двух ключах и доходит до сессии", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.route("**/api/voice/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        provider: "openai",
        mode: "live",
        providers: { openai: { configured: true }, gemini: { configured: true } },
      }),
    }),
  );
  const asked = [];
  await page.route("**/api/voice/session", async (route) => {
    asked.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "mock" }),
    });
  });
  await page.goto("/");

  // Выбор живёт в настройках, куда ведёт шестерёнка в шапке.
  await page.locator(".settings-link").click();
  const picker = page.locator("#setting-voiceProvider");
  await expect(picker).toBeVisible();
  await picker.selectOption("gemini");
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-status")).toHaveText("Сохранено");
  await page.locator('nav a[href="#today"]').click();

  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-panel")).toBeVisible();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[0].provider).toBe("gemini");

  // Выбор переживает перезагрузку: он хранится на сервере, а не во вкладке.
  await page.reload();
  await page.goto("/#settings");
  await expect(page.locator("#setting-voiceProvider")).toHaveValue("gemini");
});

test("в настройках видно, каким голосом идёт разговор сейчас", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/#settings");
  // Строка под выбором говорит, что работает на самом деле: выбор может быть
  // пустым («выбирает ключ»), а разговор всё равно идёт чем-то конкретным.
  await expect(page.locator("#state-voiceProvider")).toHaveText(
    /сейчас .+|ключа нет — разговор без модели/,
  );
});

// Экран разговора по макету: шапка с историей, знаком и настройками, кольцо с
// волнами внутри, подпись состояния, мелкий эквалайзер и строка ввода.
test("экран разговора собран по макету: шапка, кольцо, подпись, поле", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();

  const panel = page.locator("#voice-panel");
  await expect(panel).toHaveClass(/voice-live/);
  await expect(panel.getByRole("link", { name: "История" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Настройки" })).toBeVisible();
  await expect(panel.locator(".voice-brand-word")).toHaveText("Кизуна");

  // Кольцо: три дуги, стекло и холст волн внутри.
  await expect(panel.locator(".voice-arc")).toHaveCount(3);
  await expect(panel.locator(".voice-waves")).toBeVisible();
  await expect(panel.locator(".voice-bar")).toHaveCount(7);
  await expect(panel.locator("#voice-phase")).toHaveText("Слушаю");

  // Сказанное живёт под кольцом, а не отдельным блоком у поля ввода.
  const captionInsideStage = await page.evaluate(
    () => document.querySelector("#voice-log")?.parentElement?.classList.contains("voice-stage"),
  );
  expect(captionInsideStage).toBe(true);

  // Ссылки шапки ведут в журнал и настройки — из разговора есть выход.
  await expect(panel.getByRole("link", { name: "История" })).toHaveAttribute("href", "#history-work");
  await expect(panel.getByRole("link", { name: "Настройки" })).toHaveAttribute("href", "#settings");

  // После закрытия панель снова обычная, а реплики возвращаются на своё место.
  await page.locator(".voice-close").click();
  await expect(panel).not.toHaveClass(/voice-live/);
  const captionBack = await page.evaluate(
    () => document.querySelector("#voice-log")?.parentElement?.id === "voice-panel",
  );
  expect(captionBack).toBe(true);
});

// Журнала за экраном разговора не видно, поэтому разговор сам говорит, что
// записал и в какую колонку: иначе человеку кажется, что запись не появилась.
test("разговор показывает, что записал и в какую колонку", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeGemini(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  // Сокет поднимается не мгновенно: пока разговор не начался, подставного
  // сокета ещё нет и слать в него нечего. Соседние проверки ждут того же.
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");

  // Модель просит записать отчёт о сделанном — как это приходит по сокету.
  await page.evaluate(() => {
    window.__geminiSocket.emit("message", {
      data: JSON.stringify({
        toolCall: {
          functionCalls: [
            {
              name: "create_capture",
              id: "call-1",
              args: { text: "поговорил с Ильёй по колл-центру", type: "outcome" },
            },
          ],
        },
      }),
    });
  });

  const done = page.locator(".voice-line.voice-done");
  await expect(done).toHaveText(/Записал в «Что делал»/, { timeout: 20000 });
  await expect(done).toContainText("Ильёй");

  // Удаление и возврат тоже видно.
  const captureId = await page.evaluate(async () => {
    const list = await (await fetch("/api/entries?limit=5")).json();
    return list.entries[0].id;
  });
  await page.evaluate((id) => {
    window.__geminiSocket.emit("message", {
      data: JSON.stringify({
        toolCall: { functionCalls: [{ name: "delete_capture", id: "call-2", args: { captureId: id } }] },
      }),
    });
  }, captureId);
  await expect(page.locator(".voice-line.voice-done").last()).toContainText("Убрал запись");

  await page.evaluate((id) => {
    window.__geminiSocket.emit("message", {
      data: JSON.stringify({
        toolCall: { functionCalls: [{ name: "restore_capture", id: "call-3", args: { captureId: id } }] },
      }),
    });
  }, captureId);
  await expect(page.locator(".voice-line.voice-done").last()).toContainText("Вернул запись");
});

// Переключение голоса из шапки: «чем сейчас говорить» — такое же быстрое
// решение, как и выбор модели разбора, поэтому живёт там же.
test("голос переключается прямо из шапки", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      saved = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settings: { ...base.settings, voiceProvider: saved.voiceProvider },
          voice: base.voice,
          voices: base.voices,
          timeZone: "Europe/Samara",
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(base) });
  });
  let saved = null;
  const base = {
    settings: { voiceProvider: "openai", sleepAfterSeconds: "25", wakeWord: "кизуна", previewLimit: "3" },
    voice: {
      configured: true,
      provider: "openai",
      mode: "live",
      providers: { openai: { configured: true }, gemini: { configured: true } },
    },
    voices: { openai: [{ id: "marin", label: "Marin", gender: "female" }], gemini: [{ id: "Puck", label: "Puck", gender: "male" }] },
    timeZone: "Europe/Samara",
  };
  await page.goto("/");

  await page.locator(".ai-menu summary").click();
  const picker = page.locator("#voice-quick-provider");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue("openai");

  await picker.selectOption("gemini");
  await expect.poll(() => saved?.voiceProvider).toBe("gemini");
  await expect(page.locator("#toast")).toContainText("Голос: Google Gemini");
});

test("с одним ключом переключать голос нечем", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: { voiceProvider: "gemini", sleepAfterSeconds: "25", wakeWord: "кизуна", previewLimit: "3" },
        voice: {
          configured: true,
          provider: "gemini",
          mode: "live",
          providers: { openai: { configured: false }, gemini: { configured: true } },
        },
        voices: { openai: [], gemini: [] },
        timeZone: "Europe/Samara",
      }),
    }),
  );
  await page.goto("/");
  await page.locator(".ai-menu summary").click();
  // Выбора нет — и строки нет: пустой список только мешал бы.
  await expect(page.locator(".voice-quick-picker")).toBeHidden();
});

// На низком окне экран разговора обрезал последнюю строку подсказки, а поле
// ввода уезжало за край: средняя строка раскладки не умела сжиматься.
test("экран разговора влезает в низкое окно: ужимается круг, а не текст", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 620 });
  await installFakeRealtime(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  const panel = page.locator("#voice-panel");
  await expect(panel).toHaveClass(/voice-live/, { timeout: 15000 });

  const fits = await page.evaluate(() => {
    const box = document.querySelector("#voice-panel");
    const hint = document.querySelector("#voice-hint");
    const form = box.querySelector("form");
    return {
      целиком: box.scrollHeight <= window.innerHeight + 1,
      подсказка: Math.round(hint.getBoundingClientRect().bottom) <= window.innerHeight,
      поле: Math.round(form.getBoundingClientRect().bottom) <= window.innerHeight,
      круг: parseFloat(getComputedStyle(document.querySelector(".voice-orb")).width),
    };
  });
  expect(fits.целиком).toBe(true);
  expect(fits.подсказка).toBe(true);
  expect(fits.поле).toBe(true);
  // Уступает место именно круг: он украшение, а подпись и поле — само дело.
  expect(fits.круг).toBeLessThan(300);

  // На высоком окне круг возвращается к своему полному размеру: правка
  // забирает место только тогда, когда его правда нет. Сравниваем с низким
  // окном, а не с числом: точное значение зависит от того, как быстро браузер
  // пересчитает vh после смены размера.
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect
    .poll(async () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".voice-orb")).width)))
    .toBeGreaterThan(fits.круг);
});
