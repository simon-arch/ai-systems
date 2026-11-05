"use strict";

const CATEGORY_LABELS = {
  insult: "образа",
  hate: "ненависть",
  threat: "погроза",
  harassment: "цькування",
  sexual: "сексуальний контент",
  spam_scam: "шахрайство",
  profanity: "лайка",
  personal_data: "особисті дані"
};

const VERDICT_LABELS = {
  allow: "Дозволено",
  warn: "Попередження",
  block: "Заблоковано"
};

const $ = (selector) => document.querySelector(selector);

const state = {
  messages: [],
  busy: false,
  controller: null,
  nextId: 1,
  timer: null
};

function el(tag, cls, text) {
  const node = document.createElement(tag);

  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;

  return node;
}

// Server Ping
async function checkHealth() {
  const box = $("#status");
  const text = $("#status-text");

  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();

    const data = await response.json();

    box.className = `status ${data.ok ? "ok" : "bad"}`;
    text.textContent = data.ok
      ? `Модель: ${data.message}`
      : data.message;
  } catch {
    box.className = "status bad";
    text.textContent = "Сервер застосунку недоступний";
  }
}

// Chat
function renderChat() {
  const list = $("#messages");
  list.replaceChildren();

  if (!state.messages.length) {
    list.append(el("li", "empty",
      "Повідомлень ще немає. Напишіть щось нижче або візьміть приклад."
    ));
    return;
  }

  for (const m of state.messages) {
    const li = el("li",
      `msg ${m.status === "done" ? m.result.action : m.status}`
    );

    const head = el("div", "msg-head");
    head.append(
      el("b", "nickname-label", m.nickname),
      el("span", "", m.time.toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit"
      }))
    );

    li.append(head);

    const blocked = m.status === "done" &&
      m.result.action === "block";

    if (blocked && !m.revealed) {
      li.append(el("div", "msg-text hidden-text",
        "Повідомлення приховано модератором."
      ));

      const show = el("button", "link", "Показати");
      show.type = "button";

      show.onclick = () => {
        m.revealed = true;
        renderChat();
      };

      li.append(show);
    } else {
      li.append(el("div", "msg-text", m.text));

      if (blocked) {
        li.append(el("div", "msg-note", "Заблоковано."));
      }
    }

    if (m.status === "pending") {
      li.append(el("div", "msg-note", "Перевірка..."));
    }

    if (m.status === "done" && m.result.action === "warn") {
      li.append(el("div", "msg-note", "Попередження."));
    }

    if (["error", "cancelled"].includes(m.status)) {
      const note = el("div", "msg-note",
        m.status === "error"
          ? "Не перевірено. "
          : "Перевірку скасовано. "
      );

      const retry = el("button", "link", "Повторити");
      retry.type = "button";
      retry.onclick = () => moderate(m);

      note.append(retry);
      li.append(note);
    }

    list.append(li);
  }

  list.scrollTop = list.scrollHeight;
}

// Moderation logs
function renderLog() {
  const list = $("#log");
  list.replaceChildren();

  if (!state.messages.length) {
    list.append(el("li", "empty",
      "Список рішень моделі для кожного повідомлення."
    ));
    return;
  }

  for (const m of [...state.messages].reverse()) {
    const li = el("li", "entry");
    const head = el("div", "entry-head");

    if (m.status === "done") {
      const action = m.result.action;

      head.append(
        el("span", `verdict ${action}`, VERDICT_LABELS[action])
      );

      const meter = el("span", `meter ${action}`);
      meter.title = `Тяжкість ${m.result.severity} з 3`;

      for (let i = 1; i <= 3; i++) {
        meter.append(el("i", i <= m.result.severity ? "on" : ""));
      }

      head.append(meter);

    } else if (m.status === "pending") {
      const verdict = el("span", "verdict pending");
      verdict.append(el("span", "spinner"), " Модель аналізує...");
      head.append(verdict);

    } else {
      head.append(el("span", "verdict pending",
        m.status === "error" ? "Помилка" : "Скасовано"
      ));
    }

    li.append(head, el("div", "quote", m.text));

    if (m.status === "pending") {
      const meta = el("div", "meta", "0.0 с");
      meta.id = `elapsed-${m.id}`;

      const raw = el("div", "raw", m.raw);
      raw.id = `raw-${m.id}`;

      li.append(meta, raw);

    } else if (m.status === "done") {
      li.append(el("p", "reason", m.result.reason || "—"));

      if (m.result.categories.length) {
        const tags = el("div", "tags");

        for (const category of m.result.categories) {
          tags.append(el("span", "tag",
            CATEGORY_LABELS[category] || category
          ));
        }

        li.append(tags);
      }

      const stats = m.result.stats;

      li.append(el("div", "meta", [
        `${stats.seconds} с`,
        `${stats.tokens} токенів`,
        stats.tokens_per_s ? `${stats.tokens_per_s} токенів/с` : null
      ].filter(Boolean).join(" · ")));

    } else if (m.status === "error") {
      const error = el("p", "error-text", m.error);
      error.setAttribute("role", "alert");
      li.append(error);
    }

    list.append(li);
  }
}

function render() {
  renderChat();
  renderLog();
}

// Button and Timer
function setBusy(busy) {
  state.busy = busy;

  const send = $("#send");
  send.textContent = busy ? "Скасувати" : "Надіслати";
  send.classList.toggle("cancel", busy);

  clearInterval(state.timer);
  state.timer = null;

  if (!busy) return;

  const started = performance.now();

  state.timer = setInterval(() => {
    const node = document.querySelector("[id^='elapsed-']");

    if (node) {
      node.textContent = `${((performance.now() - started) / 1000).toFixed(1)} с`;
    }
  }, 200);
}

// Server-Sent Events
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  function processBlock(block) {
    let event = "message";
    let data = "";

    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }

    if (data) onEvent(event, JSON.parse(data));
  }

  for (;;) {
    const { value, done } = await reader.read();

    buffer += decoder.decode(value || new Uint8Array(), {
      stream: !done
    });

    let index;

    while ((index = buffer.indexOf("\n\n")) !== -1) {
      processBlock(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }

    if (done) break;
  }

  if (buffer.trim()) processBlock(buffer);
}

// Moderation
async function moderate(msg) {
  if (state.busy) return;

  const index = state.messages.indexOf(msg);

  const history = state.messages
    .slice(0, index)
    .filter((m) => m.status === "done")
    .slice(-6)
    .map(({ text }) => ({ text }));

  Object.assign(msg, {
    status: "pending",
    raw: "",
    error: "",
    result: null,
    revealed: false
  });

  const controller = new AbortController();
  state.controller = controller;

  setBusy(true);
  render();

  let finished = false;

  try {
    const response = await fetch("/api/moderate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        text: `${msg.nickname}: ${msg.text}`,
        history,
        strictness: $("#strictness").value
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        data.message || `Сервер відповів помилкою ${response.status}.`
      );
    }

    await readEvents(response, (event, data) => {
      if (event === "token") {
        msg.raw += data.t;

        const raw = document.getElementById(`raw-${msg.id}`);
        if (raw) raw.textContent = msg.raw;

      } else if (event === "result") {
        Object.assign(msg, {
          status: "done",
          result: data
        });
        finished = true;

      } else if (event === "error") {
        Object.assign(msg, {
          status: "error",
          error: data.message
        });
        finished = true;
      }
    });

    if (!finished) {
      throw new Error(
        "Зв'язок із сервером перервано."
      );
    }

  } catch (error) {
    if (error.name === "AbortError") {
      msg.status = "cancelled";
    } else {
      Object.assign(msg, {
        status: "error",
        error: error instanceof TypeError
          ? "Сервер застосунку недоступний."
          : error.message
      });
    }

  } finally {
    state.controller = null;
    setBusy(false);
    render();

    if (msg.status === "error") {
      checkHealth();
    }
  }
}

// Send message
function send() {
  if (state.busy) {
    state.controller?.abort();
    return;
  }

  const input = $("#input");
  const nicknameInput = $("#nickname");

  const text = input.value.trim();
  const nickname = nicknameInput.value.trim() || "Anonymous";

  if (!text) return;

  const msg = {
    id: state.nextId++,
    nickname,
    text,
    time: new Date()
  };

  state.messages.push(msg);
  input.value = "";

  moderate(msg);
}

// Events
$("#send").onclick = send;
$("#input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

checkHealth();
setInterval(checkHealth, 10000);