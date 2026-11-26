const $ = (id) => document.getElementById(id);
const form = $("chatForm"), input = $("prompt"), sendButton = $("sendButton"), sendLabel = $("sendLabel");
const messagesEl = $("messages"), scrollEl = $("scroll"), welcome = $("welcome");
const usageText = $("usageText"), usageBar = $("usageBar"), countEl = $("count");
const listEl = $("chatList"), titleEl = $("title");
const fileInput = $("fileInput"), attachButton = $("attachButton"), attachmentsEl = $("attachments");
const workspaceEl = $("workspace");
const MAX = 6000, MAX_FILES = 10, MAX_TOTAL_BYTES = 16 * 1024 * 1024, KEY = "iso-chats-v1";

let chats = load();      // [{id, title, messages:[{role, content, apiContent?, reasoning_details?, attachments?}]}]
let current = null;
let pendingFiles = [];   // [{file, previewUrl?}]
let busy = false, controller = null, cooldownTimer = null, cooling = false;

/* ---------- storage ---------- */
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function save() {
  try {
    // Strip transient blob URLs before persisting to localStorage
    const clean = chats.slice(0, 30).map((c) => ({
      id: c.id,
      title: c.title,
      messages: c.messages.map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.apiContent) out.apiContent = m.apiContent;
        if (m.reasoning_details !== undefined && m.reasoning_details !== null) {
          out.reasoning_details = m.reasoning_details;
        }
        if (m.attachments && m.attachments.length) {
          out.attachments = m.attachments.map(({ name, size, isImage, isZip }) => ({ name, size, isImage, isZip }));
        }
        return out;
      }),
    }));
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {}
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
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/* ---------- attachments ---------- */
function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}
function isZipFile(file) {
  return /\.zip$/i.test(file.name) || file.type === "application/zip";
}

function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;
  let totalBytes = pendingFiles.reduce((sum, item) => sum + item.file.size, 0);

  for (const file of incoming) {
    if (pendingFiles.length >= MAX_FILES) {
      appendMessage("assistant", `You can attach up to ${MAX_FILES} files per message.`, "error");
      break;
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      appendMessage("assistant", `Total attachment size exceeds ${formatBytes(MAX_TOTAL_BYTES)}.`, "error");
      break;
    }
    totalBytes += file.size;
    const item = { file, previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null };
    pendingFiles.push(item);
  }
  renderPendingAttachments();
}

function removePendingFile(index) {
  const [removed] = pendingFiles.splice(index, 1);
  if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderPendingAttachments();
}

function clearPendingFiles(revoke = true) {
  if (revoke) {
    pendingFiles.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
  }
  pendingFiles = [];
  renderPendingAttachments();
}

function renderPendingAttachments() {
  attachmentsEl.replaceChildren();
  attachmentsEl.hidden = pendingFiles.length === 0;
  pendingFiles.forEach((item, index) => {
    const chip = el("div", { className: "att-chip" });
    if (item.previewUrl) {
      chip.append(el("img", { className: "att-thumb", src: item.previewUrl, alt: item.file.name }));
    } else {
      chip.append(icon(isZipFile(item.file) ? "zip" : "file"));
    }
    const meta = el("span", { className: "att-meta" },
      el("span", { className: "att-name", textContent: item.file.name, title: item.file.name }),
      el("small", { className: "att-size", textContent: formatBytes(item.file.size) })
    );
    const rm = el("button", { type: "button", className: "att-rm", title: "Remove file", ariaLabel: `Remove ${item.file.name}` }, icon("x"));
    rm.addEventListener("click", () => removePendingFile(index));
    chip.append(meta, rm);
    attachmentsEl.append(chip);
  });
}

function renderMessageAttachments(atts) {
  if (!atts || !atts.length) return null;
  const wrap = el("div", { className: "msg-atts" });
  atts.forEach((a) => {
    const item = el("div", { className: "msg-att" });
    if (a.previewUrl) {
      item.append(el("img", { className: "msg-att-img", src: a.previewUrl, alt: a.name }));
    } else {
      item.append(icon(a.isZip ? "zip" : "file"));
    }
    item.append(el("span", { textContent: `${a.name} (${formatBytes(a.size)})` }));
    wrap.append(item);
  });
  return wrap;
}

/* ---------- messages ---------- */
function nearBottom() { return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 140; }
function toBottom(force) { if (force || nearBottom()) scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" }); }

function appendMessage(role, content, extra = "", attachments = null) {
  const art = el("article", { className: `message ${role} ${extra}`.trim() });
  const label = el("div", { className: "label", textContent: role === "user" ? "You" : "ISO" });
  art.append(label);

  if (attachments && attachments.length) {
    art.append(renderMessageAttachments(attachments));
  }

  let body = null;
  if (content instanceof Node) body = content;
  else if (role === "assistant" && !extra) body = renderMarkdown(content);
  else if (typeof content === "string" && content.length > 0) body = el("div", { className: "body", textContent: content });
  if (body) art.append(body);

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
  msgs.forEach((m) => appendMessage(m.role, m.content, "", m.attachments));
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
function buildPayloadMessages() {
  return current.messages.slice(-20).map((m) => {
    const out = { role: m.role, content: m.apiContent || m.content };
    if (m.role === "assistant" && m.reasoning_details !== undefined && m.reasoning_details !== null) {
      out.reasoning_details = m.reasoning_details;
    }
    return out;
  });
}

async function requestReply(filesToSend = []) {
  busy = true; setSendState();
  const pending = appendMessage("assistant", thinkingNode());
  controller = new AbortController();
  try {
    const payloadMessages = buildPayloadMessages();
    let res;
    if (filesToSend.length > 0) {
      const fd = new FormData();
      fd.append("messages", JSON.stringify(payloadMessages));
      filesToSend.forEach((f) => fd.append("files", f, f.name));
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "X-Requested-With": "iso-chat" },
        body: fd,
        signal: controller.signal,
      });
    } else {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "iso-chat" },
        body: JSON.stringify({ messages: payloadMessages }),
        signal: controller.signal,
      });
    }

    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (!res.ok) {
      appendMessage("assistant", data.error || "Request failed.", "error");
      if (res.status === 429) { const s = parseInt(res.headers.get("Retry-After"), 10); if (s) startCooldown(s); }
      return false;
    }

    // Preserve extracted document text on the last user message so follow-ups keep context.
    if (typeof data.file_context === "string" && current.messages.length) {
      const lastUser = current.messages[current.messages.length - 1];
      if (lastUser && lastUser.role === "user") {
        lastUser.apiContent = data.file_context;
      }
    }

    const reply = typeof data.reply === "string" ? data.reply : "No response was returned.";
    const assistantEntry = { role: "assistant", content: reply };
    if (data.reasoning_details !== undefined && data.reasoning_details !== null) {
      assistantEntry.reasoning_details = data.reasoning_details;
    }
    current.messages.push(assistantEntry);
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
  const hasFiles = pendingFiles.length > 0;
  if (busy || cooling || (!content && !hasFiles) || content.length > MAX) return;

  const filesToSend = pendingFiles.map((item) => item.file);
  const msgAttachments = pendingFiles.map((item) => ({
    name: item.file.name,
    size: item.file.size,
    isImage: isImageFile(item.file),
    isZip: isZipFile(item.file),
    previewUrl: item.previewUrl,
  }));

  const defaultTitle = content ? content.slice(0, 40) : msgAttachments.map((a) => a.name).join(", ").slice(0, 40);
  if (!current) {
    current = { id: Date.now(), title: defaultTitle, messages: [] };
    chats.unshift(current);
  }
  welcome.hidden = true;
  current.messages.push({ role: "user", content, attachments: msgAttachments.length ? msgAttachments : undefined });
  save(); renderList(); titleEl.textContent = current.title;
  appendMessage("user", content, "", msgAttachments);

  input.value = ""; resize();
  clearPendingFiles(false); // keep previewUrl alive for the rendered user bubble
  await requestReply(filesToSend);
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
attachButton.addEventListener("click", () => { if (!busy) fileInput.click(); });
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = "";
  input.focus();
});

// Paste images/files from clipboard
input.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.files;
  if (items && items.length) {
    e.preventDefault();
    addFiles(items);
  }
});

// Drag & drop files onto the workspace
let dragDepth = 0;
workspaceEl.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    dragDepth++;
    form.classList.add("drag-over");
  }
});
workspaceEl.addEventListener("dragover", (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
  }
});
workspaceEl.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) form.classList.remove("drag-over");
});
workspaceEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  form.classList.remove("drag-over");
  if (!busy && e.dataTransfer && e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
    input.focus();
  }
});

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
  current = null; clearPendingFiles(true); renderChat(); input.value = ""; resize(); input.focus();
});

$("exportChat").addEventListener("click", () => {
  if (!current || !current.messages.length) return;
  const md = `# ${current.title}\n\n` + current.messages.map((m) => {
    const attLine = m.attachments && m.attachments.length
      ? `_Attachments: ${m.attachments.map((a) => a.name).join(", ")}_\n\n`
      : "";
    return `**${m.role === "user" ? "You" : "ISO"}**\n\n${attLine}${m.content}`;
  }).join("\n\n---\n\n");
  const a = el("a", { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: `${current.title.replace(/[^\w-]+/g, "_") || "chat"}.md` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

renderChat(); resize(); refreshUsage();
