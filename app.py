import os
import time
from threading import Lock

import requests

try:
    import redis
except ImportError:  # optional locally, required on Vercel
    redis = None
from dotenv import load_dotenv
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

app = Flask(__name__, static_folder="public", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # 64 KB

# Set TRUST_PROXY=1 when behind Cloudflare/nginx/Render so the real client IP is used.
if os.getenv("TRUST_PROXY") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

API_KEY = os.getenv("OPENROUTER_API_KEY", "")
API_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "nvidia/nemotron-3.5-lightning:free"

DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "100"))              # per IP, per UTC day
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
        "img-src 'self' data:; font-src https://fonts.gstatic.com; "
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
    if not request.is_json:
        return jsonify({"error": "Send JSON."}), 415
    if not API_KEY:
        return jsonify({"error": "Server API key is not configured."}), 503

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request."}), 400

    messages = data.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "Send at least one message."}), 400
    if len(messages) > MAX_HISTORY_MESSAGES:
        return jsonify({"error": "Conversation is too long. Start a new chat."}), 400

    cleaned = []
    for msg in messages:
        if not isinstance(msg, dict):
            return jsonify({"error": "Invalid message format."}), 400
        role, content = msg.get("role"), msg.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            return jsonify({"error": "Invalid message content."}), 400
        content = content.strip()
        if not content or len(content) > MAX_MESSAGE_LENGTH:
            return jsonify({
                "error": f"Each message must contain 1–{MAX_MESSAGE_LENGTH} characters."
            }), 400
        cleaned.append({"role": role, "content": content})

    if cleaned[-1]["role"] != "user":
        return jsonify({"error": "The last message must be from the user."}), 400

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
            API_URL,
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
                "X-Title": "ISO Chat",
            },
            json={
                "model": MODEL,
                "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + cleaned,
                "reasoning": {"enabled": True},
            },
            timeout=(10, int(os.getenv("AI_TIMEOUT", "55"))),
        )

        if response.status_code == 429:
            refund(ip)
            return jsonify({"error": "The AI provider is busy. Please try again shortly."}), 429

        response.raise_for_status()
        message = response.json()["choices"][0]["message"]

        # Return the answer only, not private provider reasoning details.
        return jsonify({"reply": message.get("content") or "No text response was returned."})

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
    return jsonify({"error": "Request payload is too large."}), 413


if __name__ == "__main__":
    app.run(debug=False, port=5000)
