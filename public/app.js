const $ = (id) => document.getElementById(id);
const form = $("chatForm"), input = $("prompt"), sendButton = $("sendButton"), sendLabel = $("sendLabel");
const messagesEl = $("messages"), scrollEl = $("scroll"), welcome = $("welcome");
const usageText = $("usageText"), usageBar = $("usageBar"), countEl = $("count");
const listEl = $("chatList"), titleEl = $("title");
const MAX = 6000, KEY = "iso-chats-v1";

let chats = load();      // [{id, title, messages:[{role, content}]}]
let current = null;
let busy = false, controller = null, cooldownTimer = null, cooling = false;

/* ---------- storage ---------- */
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(chats.slice(0, 30))); } catch {}
}

/* ---------- theme ---------- */
const root = document.documentElement;
$("themeToggle").addEventListener("click", () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("iso-theme", root.dataset.theme); } catch {}
});

/* ---------- safe markdown (builds DOM nodes, never innerHTML) ---------- */
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(el("code", { textContent: m[1].slice(1, -1) }));
    else if (m[2]) frag.append(el("strong", { textContent: m[2].slice(2, -2) }));
    else {
      const [, label, url] = m[3].match(/\[(.+?)\]\((.+)\)/);
      frag.append(el("a", { textContent: label, href: url, target: "_blank", rel: "noopener noreferrer" }));
    }
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  return frag;
}
const NS = "http://www.w3.org/2000/svg";
function icon(name) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", "ic");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(NS, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
function iconBtn(name, label, act) {
  const b = el("button", { type: "button", className: "tool", title: label, ariaLabel: label });
  b.dataset.act = act || name;
  b.append(icon(name));
  return b;
}
function copyBtn(getText) {
  const b = iconBtn("copy", "Copy");
  b.addEventListener("click", async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(getText()); } catch { ok = false; }
    b.replaceChildren(icon(ok ? "check" : "stop"));
    b.classList.add("ok");
    setTimeout(() => { b.replaceChildren(icon("copy")); b.classList.remove("ok"); }, 1400);
  });
  return b;
}
function renderMarkdown(src) {
  const root = el("div", { className: "body md" });
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2) { // fenced code
      const nl = part.indexOf("\n");
      const lang = nl > -1 ? part.slice(0, nl).trim() : "";
      const code = (nl > -1 ? part.slice(nl + 1) : part).replace(/\n$/, "");
      root.append(el("div", { className: "code" },
        el("div", { className: "code-head" }, el("span", { textContent: lang || "code" }), copyBtn(() => code)),
        el("pre", {}, el("code", { textContent: code }))));
      return;
    }
    let list = null;
    part.split("\n").forEach((line) => {
      const ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const item = ul || ol;
      if (item) {
        const type = ul ? "UL" : "OL";
        if (!list || list.tagName !== type) { list = el(type.toLowerCase()); root.append(list); }
        list.append(el("li", {}, inline(item[1])));
        return;
      }
      list = null;
      const h = line.match(/^#{1,6}\s+(.*)/);
      if (h) root.append(el("h4", {}, inline(h[1])));
      else if (line.trim()) root.append(el("p", {}, inline(line)));
    });
  });
  return root;
}

/* ---------- messages ---------- */
function nearBottom() { return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 140; }
function toBottom(force) { if (force || nearBottom()) scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" }); }

function appendMessage(role, content, extra = "") {
  const art = el("article", { className: `message ${role} ${extra}`.trim() });
  const label = el("div", { className: "label", textContent: role === "user" ? "You" : "ISO" });
  let body;
  if (content instanceof Node) body = content;
  else if (role === "assistant" && !extra) body = renderMarkdown(content);
  else body = el("div", { className: "body", textContent: content });
  art.append(label, body);

  if (role === "assistant" && !extra && typeof content === "string") {
    const tools = el("div", { className: "tools" }, copyBtn(() => content));
    const retry = iconBtn("retry", "Regenerate");
    retry.addEventListener("click", regenerate);
    tools.append(retry);
    art.append(tools);
  }
  messagesEl.append(art);
  toBottom(role === "user");
  return art;
}

function thinkingNode() {
  return el("div", { className: "thinking", role: "status" }, el("span", { className: "dots" }, el("i"), el("i"), el("i")), el("span", { textContent: "Thinking" }));
}

function renderChat() {
  messagesEl.replaceChildren();
  const msgs = current ? current.messages : [];
  welcome.hidden = msgs.length > 0;
  msgs.forEach((m) => appendMessage(m.role, m.content));
  titleEl.textContent = current ? current.title : "New chat";
  scrollEl.scrollTop = scrollEl.scrollHeight;
  renderList();
}
// Only the newest reply keeps its Regenerate button
function trimRegenerate() {
  const all = messagesEl.querySelectorAll(".message.assistant");
  all.forEach((m, i) => { if (i < all.length - 1) m.querySelectorAll(".tool").forEach((b) => b.dataset.act === "retry" && b.remove()); });
}

function renderList() {
  listEl.replaceChildren(...chats.map((c) => {
    const open = el("button", { type: "button", className: "open", textContent: c.title });
    open.addEventListener("click", () => { if (!busy) { current = c; renderChat(); input.focus(); } });
    const del = el("button", { type: "button", className: "del", title: "Delete chat", ariaLabel: `Delete ${c.title}` }, icon("trash"));
    del.addEventListener("click", () => {
      if (busy) return;
      chats = chats.filter((x) => x !== c);
      if (current === c) current = null;
      save(); renderChat();
    });
    return el("div", { className: "chat-item" + (c === current ? " active" : "") }, open, del);
  }));
}

/* ---------- usage & limits ---------- */
async function refreshUsage() {
  try {
    const r = await fetch("/api/usage");
    if (!r.ok) throw 0;
    const d = await r.json();
    usageText.textContent = `${d.remaining} / ${d.daily_limit} left`;
    usageBar.style.width = `${Math.min(100, (d.used / d.daily_limit) * 100)}%`;
  } catch { usageText.textContent = "Unavailable"; }
}

function setSendIcon(n) { const u = sendButton.querySelector("use"); if (u) u.setAttribute("href", `#i-${n}`); }
function setSendState() {
  if (busy) { sendLabel.textContent = "Stop"; sendButton.classList.add("stop"); setSendIcon("stop"); sendButton.disabled = false; return; }
  sendButton.classList.remove("stop"); setSendIcon("send");
  sendButton.disabled = cooling;
  if (!cooling) sendLabel.textContent = "Send";
}
function startCooldown(sec) {
  clearInterval(cooldownTimer);
  let left = Math.max(1, Math.min(sec, 3600));
  cooling = true; setSendState();
  const tick = () => {
    if (left <= 0) { clearInterval(cooldownTimer); cooling = false; setSendState(); return; }
    sendLabel.textContent = left > 120 ? "Limit reached" : `Wait ${left}s`;
    left--;
  };
  tick(); cooldownTimer = setInterval(tick, 1000);
}

/* ---------- sending ---------- */
async function requestReply() {
  busy = true; setSendState();
  const pending = appendMessage("assistant", thinkingNode());
  controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "iso-chat" },
      body: JSON.stringify({ messages: current.messages.slice(-20) }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (!res.ok) {
      appendMessage("assistant", data.error || "Request failed.", "error");
      if (res.status === 429) { const s = parseInt(res.headers.get("Retry-After"), 10); if (s) startCooldown(s); }
      return false;
    }
    const reply = typeof data.reply === "string" ? data.reply : "No response was returned.";
    current.messages.push({ role: "assistant", content: reply });
    save(); appendMessage("assistant", reply); trimRegenerate();
    return true;
  } catch (e) {
    pending.remove();
    appendMessage("assistant", e.name === "AbortError" ? "Stopped." : "Could not reach the server. Check your connection and try again.", "error");
    return false;
  } finally {
    busy = false; controller = null; setSendState(); input.focus(); refreshUsage();
  }
}

async function sendMessage(text) {
  const content = text.trim();
  if (busy || cooling || !content || content.length > MAX) return;
  if (!current) {
    current = { id: Date.now(), title: content.slice(0, 40), messages: [] };
    chats.unshift(current);
  }
  welcome.hidden = true;
  current.messages.push({ role: "user", content });
  save(); renderList(); titleEl.textContent = current.title;
  appendMessage("user", content);
  input.value = ""; resize();
  await requestReply();
}

async function regenerate() {
  if (busy || cooling || !current) return;
  const msgs = current.messages;
  if (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
  save();
  renderChat();
  await requestReply();
}

/* ---------- events ---------- */
function resize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  countEl.textContent = `${input.value.length} / ${MAX}`;
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { controller && controller.abort(); return; }
  sendMessage(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) form.requestSubmit(); }
});
let raf = 0;
input.addEventListener("input", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(resize); });
document.addEventListener("visibilitychange", () => root.classList.toggle("paused", document.hidden));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy && controller) controller.abort();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("newChat").click(); }
});
document.querySelectorAll("[data-prompt]").forEach((b) => b.addEventListener("click", () => {
  input.value = b.dataset.prompt; resize(); input.focus();
}));
$("newChat").addEventListener("click", () => {
  if (busy) return;
  current = null; renderChat(); input.value = ""; resize(); input.focus();
});

$("exportChat").addEventListener("click", () => {
  if (!current || !current.messages.length) return;
  const md = `# ${current.title}\n\n` + current.messages.map((m) => `**${m.role === "user" ? "You" : "ISO"}**\n\n${m.content}`).join("\n\n---\n\n");
  const a = el("a", { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: `${current.title.replace(/[^\w-]+/g, "_") || "chat"}.md` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

renderChat(); resize(); refreshUsage();
