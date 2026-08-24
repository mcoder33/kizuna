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
  // просьба продолжить вслух.
  const sent = await page.evaluate(() => window.__voiceProbe.sent);
  const output = sent.find((event) => event.item?.type === "function_call_output");
  expect(output.type).toBe("conversation.item.create");
  expect(output.item.call_id).toBe("call_test_1");
  expect(JSON.parse(output.item.output).saved).toBe(true);
  expect(sent[sent.length - 1].type).toBe("response.create");
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

test("in the live mode the browser microphone button steps aside", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await installFakeRealtime(page);
  await page.goto("/");
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Говорите вслух");
  // Микрофон уже открыт для модели — вторая запись была бы лишней.
  await expect(page.locator(".voice-listen")).toBeHidden();
});
