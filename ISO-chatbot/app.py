import base64
import io
import json
import mimetypes
import os
import time
import zipfile
from threading import Lock
from urllib.parse import urlparse

import requests

try:
    import redis
except ImportError:  # optional locally, required on Vercel
    redis = None

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

try:
    from docx import Document as DocxDocument
except ImportError:
    DocxDocument = None

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

app = Flask(__name__, static_folder="public", static_url_path="")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "16"))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# Set TRUST_PROXY=1 when behind Cloudflare/nginx/Render so the real client IP is used.
if os.getenv("TRUST_PROXY") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

API_KEY = os.getenv("OPENROUTER_API_KEY", "")
API_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.getenv("OPENROUTER_MODEL", "nvidia/nemotron-3.5-super-vl:free")

DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "100"))               # per IP, per UTC day
GLOBAL_DAILY_LIMIT = int(os.getenv("GLOBAL_DAILY_LIMIT", "1000"))  # whole site, per UTC day
# Personality. Set SYSTEM_PROMPT in .env to override without editing code.
SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT") or (
    "You are ISO, a dry, sarcastic assistant. Answer with deadpan wit, light teasing "
    "and the occasional eye-roll, but always give a correct, genuinely useful answer. "
    "Keep the sarcasm aimed at the situation or the question, never at the person's "
    "identity, and never mean-spirited. Drop the sarcasm entirely when someone seems "
    "upset, stressed, or asks about something serious like health, safety, or money. "
    "Keep replies concise, and never put sarcasm inside code or technical steps."
)
MAX_MESSAGE_LENGTH = 6000
MAX_HISTORY_MESSAGES = 20
MAX_FILES_PER_REQUEST = 10
MAX_IMAGES_PER_REQUEST = 4
MAX_EXTRACTED_TEXT_CHARS = 30000
MAX_ZIP_ENTRIES = 30
MAX_ZIP_UNCOMPRESSED_BYTES = 15 * 1024 * 1024  # 15 MB zip-bomb guard

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".log",
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm",
    ".css", ".scss", ".sass", ".less", ".sql", ".sh", ".bash", ".zsh",
    ".bat", ".ps1", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java",
    ".kt", ".go", ".rs", ".rb", ".php", ".swift", ".r", ".lua", ".pl",
    ".dockerfile", ".gitignore", ".svg",
}

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],
    storage_uri=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
    headers_enabled=True,  # sends X-RateLimit-* and Retry-After
)

# Daily counters live in memory. With several workers, move these to Redis.
lock = Lock()
inflight = set()  # one AI request per IP at a time
state = {"day": None, "ip": {}, "total": 0}


def _roll_day():
    """Reset counters when the UTC day changes. Call with the lock held."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if state["day"] != today:
        state.update(day=today, ip={}, total=0)


def seconds_until_reset():
    now = time.gmtime()
    return 86400 - (now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec)


REDIS_URL = os.getenv("REDIS_URL", "")
rdb = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_timeout=3) if (redis and REDIS_URL) else None


def _today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def used_today(ip):
    if rdb:
        return int(rdb.get(f"iso:{_today()}:ip:{ip}") or 0)
    with lock:
        _roll_day()
        return state["ip"].get(ip, 0)


def reserve(ip):
    """Take one request slot. Returns None on success, else 'busy', 'ip' or 'global'."""
    if rdb:
        if not rdb.set(f"iso:busy:{ip}", 1, nx=True, ex=100):
            return "busy"
        ttl = seconds_until_reset() + 3600
        kip, kall = f"iso:{_today()}:ip:{ip}", f"iso:{_today()}:total"
        n, t = rdb.incr(kip), rdb.incr(kall)
        rdb.expire(kip, ttl); rdb.expire(kall, ttl)
        if n > DAILY_LIMIT or t > GLOBAL_DAILY_LIMIT:
            rdb.decr(kip); rdb.decr(kall); rdb.delete(f"iso:busy:{ip}")
            return "ip" if n > DAILY_LIMIT else "global"
        return None
    with lock:
        _roll_day()
        if ip in inflight:
            return "busy"
        if state["ip"].get(ip, 0) >= DAILY_LIMIT:
            return "ip"
        if state["total"] >= GLOBAL_DAILY_LIMIT:
            return "global"
        inflight.add(ip)
        state["ip"][ip] = state["ip"].get(ip, 0) + 1
        state["total"] += 1
        return None


def refund(ip):
    if rdb:
        rdb.decr(f"iso:{_today()}:ip:{ip}"); rdb.decr(f"iso:{_today()}:total")
        return
    with lock:
        _roll_day()
        state["ip"][ip] = max(0, state["ip"].get(ip, 1) - 1)
        state["total"] = max(0, state["total"] - 1)


def release(ip):
    if rdb:
        rdb.delete(f"iso:busy:{ip}")
    else:
        with lock:
            inflight.discard(ip)


def _encode_image_block(raw_bytes, filename):
    mime_type, _ = mimetypes.guess_type(filename)
    if not mime_type or not mime_type.startswith("image/"):
        mime_type = "image/png"
    b64 = base64.b64encode(raw_bytes).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime_type};base64,{b64}"},
    }


def _looks_like_text(raw_bytes):
    if not raw_bytes:
        return True
    sample = raw_bytes[:4096]
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _extract_file(filename, raw_bytes, depth=0):
    """Extract (text_chunks, image_blocks) from an uploaded file."""
    safe_name = os.path.basename(filename) or "file"
    ext = os.path.splitext(safe_name)[1].lower()
    text_chunks = []
    image_blocks = []

    if ext in IMAGE_EXTS:
        image_blocks.append(_encode_image_block(raw_bytes, safe_name))
        return text_chunks, image_blocks

    if ext == ".pdf":
        if PdfReader is None:
            text_chunks.append(f"[File: {safe_name} — PDF parser not installed]")
            return text_chunks, image_blocks
        try:
            reader = PdfReader(io.BytesIO(raw_bytes))
            pages = []
            for idx, page in enumerate(reader.pages, 1):
                txt = (page.extract_text() or "").strip()
                if txt:
                    pages.append(f"[Page {idx}]\n{txt}")
            body = "\n\n".join(pages) or "(No extractable text found in PDF)"
            text_chunks.append(f"--- PDF: {safe_name} ({len(reader.pages)} pages) ---\n{body}")
        except Exception:
            text_chunks.append(f"--- PDF: {safe_name} (failed to parse PDF) ---")
        return text_chunks, image_blocks

    if ext == ".docx":
        if DocxDocument is None:
            text_chunks.append(f"[File: {safe_name} — DOCX parser not installed]")
            return text_chunks, image_blocks
        try:
            doc = DocxDocument(io.BytesIO(raw_bytes))
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables:
                rows = []
                for row in table.rows:
                    cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                    rows.append(" | ".join(cells))
                if rows:
                    parts.append("\n".join(rows))
            body = "\n".join(parts) or "(Empty document)"
            text_chunks.append(f"--- DOCX: {safe_name} ---\n{body}")
        except Exception:
            text_chunks.append(f"--- DOCX: {safe_name} (failed to parse DOCX) ---")
        return text_chunks, image_blocks

    if ext == ".zip" and depth == 0:
        try:
            with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
                infos = [i for i in zf.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
                listing = [f"{i.filename} ({i.file_size} bytes)" for i in infos[:100]]
                header = f"--- ZIP Archive: {safe_name} ({len(infos)} files) ---\nContents:\n" + "\n".join(listing)
                text_chunks.append(header)

                total_uncompressed = 0
                for info in infos[:MAX_ZIP_ENTRIES]:
                    if info.file_size <= 0:
                        continue
                    if total_uncompressed + info.file_size > MAX_ZIP_UNCOMPRESSED_BYTES:
                        text_chunks.append(f"[Remaining files in {safe_name} skipped due to size limit]")
                        break
                    total_uncompressed += info.file_size
                    inner_bytes = zf.read(info.filename)
                    sub_texts, sub_imgs = _extract_file(info.filename, inner_bytes, depth=1)
                    text_chunks.extend(sub_texts)
                    image_blocks.extend(sub_imgs)
        except zipfile.BadZipFile:
            text_chunks.append(f"--- ZIP: {safe_name} (invalid or corrupted ZIP archive) ---")
        return text_chunks, image_blocks

    if ext in TEXT_EXTS or _looks_like_text(raw_bytes):
        decoded = raw_bytes.decode("utf-8", errors="replace").strip()
        text_chunks.append(f"--- File: {safe_name} ---\n{decoded or '(Empty file)'}")
        return text_chunks, image_blocks

    mime_type, _ = mimetypes.guess_type(safe_name)
    text_chunks.append(
        f"--- Binary File: {safe_name} (type: {mime_type or 'unknown'}, size: {len(raw_bytes)} bytes; binary content not directly readable) ---"
    )
    return text_chunks, image_blocks


@app.context_processor
def static_version():
    """Cache-bust CSS/JS so edits always show up in the browser."""
    def v(name):
        try:
            return int(os.path.getmtime(os.path.join(app.static_folder, name)))
        except OSError:
            return 0
    return {"v": v}


@app.after_request
def security_headers(resp):
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; connect-src 'self'; "
        "img-src 'self' data: blob:; font-src https://fonts.gstatic.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def same_origin():
    """Block other websites and scripts from spending your quota."""
    if request.headers.get("X-Requested-With") != "iso-chat":
        return False
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc != request.host:
        return False
    return True


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/usage")
@limiter.limit("30 per minute")
def usage():
    ip = get_remote_address()
    used = used_today(ip)
    return jsonify({
        "daily_limit": DAILY_LIMIT,
        "used": used,
        "remaining": max(0, DAILY_LIMIT - used),
        "resets_in": seconds_until_reset(),
    })


@app.post("/api/chat")
@limiter.limit("10 per minute; 60 per hour")
def chat():
    if not same_origin():
        return jsonify({"error": "Request rejected."}), 403
    if not API_KEY:
        return jsonify({"error": "Server API key is not configured."}), 503

    uploaded_files = []
    if request.content_type and request.content_type.startswith("multipart/form-data"):
        raw_messages = request.form.get("messages", "[]")
        try:
            messages = json.loads(raw_messages)
        except ValueError:
            return jsonify({"error": "Invalid messages JSON."}), 400
        uploaded_files = [f for f in request.files.getlist("files") if f and f.filename]
    elif request.is_json:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Invalid JSON request."}), 400
        messages = data.get("messages")
    else:
        return jsonify({"error": "Send JSON or multipart/form-data."}), 415

    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "Send at least one message."}), 400
    if len(messages) > MAX_HISTORY_MESSAGES:
        return jsonify({"error": "Conversation is too long. Start a new chat."}), 400
    if len(uploaded_files) > MAX_FILES_PER_REQUEST:
        return jsonify({"error": f"You can attach up to {MAX_FILES_PER_REQUEST} files at a time."}), 400

    cleaned = []
    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            return jsonify({"error": "Invalid message format."}), 400
        role = msg.get("role")
        content = msg.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            return jsonify({"error": "Invalid message content."}), 400
        content = content.strip()
        is_last = idx == len(messages) - 1
        # Allow empty text on the last user message only when files are attached.
        if not content and not (is_last and role == "user" and uploaded_files):
            return jsonify({"error": "Message cannot be empty."}), 400
        # Prior messages with extracted file context may be longer than MAX_MESSAGE_LENGTH.
        limit = MAX_EXTRACTED_TEXT_CHARS + MAX_MESSAGE_LENGTH if idx < len(messages) - 1 else MAX_MESSAGE_LENGTH
        if len(content) > limit:
            return jsonify({
                "error": f"Each message must contain 1–{MAX_MESSAGE_LENGTH} characters."
            }), 400

        entry = {"role": role, "content": content}
        # Preserve assistant reasoning_details unmodified so the model continues reasoning.
        if role == "assistant" and "reasoning_details" in msg and msg["reasoning_details"] is not None:
            entry["reasoning_details"] = msg["reasoning_details"]
        cleaned.append(entry)

    if cleaned[-1]["role"] != "user":
        return jsonify({"error": "The last message must be from the user."}), 400

    # Process attached files for the latest user turn.
    all_text_chunks = []
    all_image_blocks = []
    for f in uploaded_files:
        raw_bytes = f.read()
        texts, imgs = _extract_file(f.filename, raw_bytes)
        all_text_chunks.extend(texts)
        all_image_blocks.extend(imgs)

    if len(all_image_blocks) > MAX_IMAGES_PER_REQUEST:
        all_image_blocks = all_image_blocks[:MAX_IMAGES_PER_REQUEST]
        all_text_chunks.append(f"[Note: Only the first {MAX_IMAGES_PER_REQUEST} images were attached to this turn.]")

    extracted_context = ""
    if all_text_chunks:
        extracted_context = "\n\n".join(all_text_chunks)
        if len(extracted_context) > MAX_EXTRACTED_TEXT_CHARS:
            extracted_context = extracted_context[:MAX_EXTRACTED_TEXT_CHARS] + "\n... [truncated]"

    last_text = cleaned[-1]["content"]
    if extracted_context:
        combined_text = (
            f"{last_text}\n\n[Attached Files]\n{extracted_context}".strip()
            if last_text
            else f"Analyze the attached file(s).\n\n[Attached Files]\n{extracted_context}"
        )
    else:
        combined_text = last_text or "Analyze the attached image(s)."

    if all_image_blocks:
        cleaned[-1]["content"] = [{"type": "text", "text": combined_text}] + all_image_blocks
    else:
        cleaned[-1]["content"] = combined_text

    ip = get_remote_address()

    # Reserve a slot (per-IP daily, site-wide daily, one request at a time).
    denied = reserve(ip)
    if denied == "busy":
        return jsonify({"error": "Wait for the current reply to finish."}), 429
    if denied:
        msg = ("Daily request limit reached. Try again tomorrow." if denied == "ip"
               else "The site has reached its daily capacity. Try again tomorrow.")
        resp = jsonify({"error": msg})
        resp.headers["Retry-After"] = str(seconds_until_reset())
        return resp, 429

    try:
        response = requests.post(
            url=API_URL,
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
                "X-Title": "ISO Chat",
            },
            data=json.dumps({
                "model": MODEL,
                "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + cleaned,
                "reasoning": {"enabled": True},
            }),
            timeout=(10, int(os.getenv("AI_TIMEOUT", "55"))),
        )

        if response.status_code == 429:
            refund(ip)
            return jsonify({"error": "The AI provider is busy. Please try again shortly."}), 429

        response.raise_for_status()
        assistant_message = response.json()["choices"][0]["message"]

        payload = {
            "reply": assistant_message.get("content") or "No text response was returned.",
            "reasoning_details": assistant_message.get("reasoning_details"),
        }
        if extracted_context:
            payload["file_context"] = combined_text
        return jsonify(payload)

    except requests.Timeout:
        refund(ip)
        return jsonify({"error": "The AI request timed out. Try again."}), 504

    except (requests.RequestException, ValueError, KeyError, IndexError):
        refund(ip)
        app.logger.exception("OpenRouter request failed")
        return jsonify({"error": "The AI service returned an unexpected response."}), 502

    finally:
        release(ip)


@app.errorhandler(429)
def rate_limited(error):
    resp = jsonify({"error": "Too many requests. Please wait a moment before trying again."})
    resp.status_code = 429
    retry = getattr(error, "retry_after", None)
    if retry:
        resp.headers["Retry-After"] = str(retry)
    return resp


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Not found."}), 404


@app.errorhandler(405)
def bad_method(_error):
    return jsonify({"error": "Method not allowed."}), 405


@app.errorhandler(500)
def server_error(_error):
    return jsonify({"error": "Something went wrong on the server."}), 500


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": f"Upload is too large (max {MAX_UPLOAD_MB} MB)."}), 413


if __name__ == "__main__":
    app.run(debug=False, port=5000)
