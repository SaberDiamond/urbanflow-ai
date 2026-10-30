#!/usr/bin/env python3
"""UrbanFlow AI — local server.

Serves the dashboard and relays model calls to Nebius Token Factory, so the API key stays on
this computer and never reaches the browser. Standard library only; no installs needed.

    python3 server.py                 # http://localhost:8000
    python3 server.py --port 8080
    python3 server.py --mock          # no key needed: answers with a labelled stand-in model

The key can be entered in the dashboard (gear button next to the controller badge) or put in
dashboard/.env as NEBIUS_API_KEY=... . Keys entered in the dashboard are kept in memory only,
unless you tick "Also save to .env".
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"

DEFAULTS = {
    "base_url": "https://api.tokenfactory.nebius.com/v1",
    "signal_model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "dispatch_model": "nvidia/nemotron-3-super-120b-a12b",
}
KNOWN_MODELS = [
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/Nemotron-3-Ultra-550b-a55b",
]


# HTTPS with certificate verification always on.
# Python installed from python.org on macOS ships without trusted root certificates until its
# "Install Certificates.command" is run, which makes every HTTPS call fail with
# CERTIFICATE_VERIFY_FAILED. So try, in order: certifi's bundle if installed; on macOS the
# system file Apple maintains, then the keychain's roots; otherwise Python's default. If a call
# still fails verification, the next source is tried.

def _certifi():
    import certifi  # type: ignore
    return ssl.create_default_context(cafile=certifi.where()), "certifi"


def _system_file():
    # macOS keeps Apple's root certificates here; python.org's Python often points at an empty
    # folder of its own instead, so on macOS always prefer this file.
    for path in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"):
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return ssl.create_default_context(cafile=path), path
    raise FileNotFoundError("no system certificate file")


def _mac_keychain():
    # last resort on macOS: export the root certificates from the system keychains
    import subprocess
    import tempfile
    pem = ""
    for kc in ("/System/Library/Keychains/SystemRootCertificates.keychain", "/Library/Keychains/System.keychain"):
        out = subprocess.run(["security", "find-certificate", "-a", "-p", kc], capture_output=True, text=True, timeout=20)
        pem += out.stdout
    if "BEGIN CERTIFICATE" not in pem:
        raise FileNotFoundError("keychain export was empty")
    path = os.path.join(tempfile.gettempdir(), "urbanflow-roots.pem")
    with open(path, "w") as f:
        f.write(pem)
    return ssl.create_default_context(cafile=path), "macOS keychain"


def _python_default():
    return ssl.create_default_context(), "python default"


def _candidates():
    order = [_certifi]
    order += [_system_file, _mac_keychain, _python_default] if sys.platform == "darwin" else [_python_default, _system_file]
    out = []
    for make in order:
        try:
            out.append(make())
        except Exception:
            continue
    return out


CERT_CHOICES = _candidates()
SSL_CTX, SSL_SOURCE = CERT_CHOICES[0]


def next_cert_source():
    """After a certificate failure, move on to the next trusted source. Verification stays on."""
    global SSL_CTX, SSL_SOURCE
    idx = next((k for k, (_, src) in enumerate(CERT_CHOICES) if src == SSL_SOURCE), 0)
    if idx + 1 >= len(CERT_CHOICES):
        return False
    SSL_CTX, SSL_SOURCE = CERT_CHOICES[idx + 1]
    print(f"  HTTPS certificates: switched to {SSL_SOURCE}")
    return True


def read_env():
    values = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def write_env(updates):
    values = read_env()
    values.update({k: v for k, v in updates.items() if v})
    ENV_PATH.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    try:
        os.chmod(ENV_PATH, 0o600)
    except OSError:
        pass


class State:
    def __init__(self, mock):
        env = read_env()
        self.mock = mock
        self.api_key = os.environ.get("NEBIUS_API_KEY") or env.get("NEBIUS_API_KEY") or ""
        self.key_source = "env" if self.api_key else None
        self.base_url = env.get("NEBIUS_BASE_URL", DEFAULTS["base_url"])
        self.signal_model = env.get("NEMOTRON_SIGNAL_MODEL", DEFAULTS["signal_model"])
        self.dispatch_model = env.get("NEMOTRON_DISPATCH_MODEL", DEFAULTS["dispatch_model"])
        self.no_thinking_ok = True  # flips off if the API rejects chat_template_kwargs
        self.json_mode_ok = True    # flips off if the API rejects response_format
        self.stats = {"calls": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0, "last_ms": None, "last_error": None}

    def public(self):
        return {
            "server": True,
            "mock": self.mock,
            "hasKey": bool(self.api_key) or self.mock,
            "keySource": "mock" if self.mock else self.key_source,
            "keyHint": ("…" + self.api_key[-4:]) if len(self.api_key) >= 8 else None,
            "baseUrl": self.base_url,
            "signalModel": self.signal_model,
            "dispatchModel": self.dispatch_model,
            "knownModels": KNOWN_MODELS,
            "stats": self.stats,
        }


STATE = None


def upstream(path, body=None, timeout=20):
    """Call Token Factory. Returns (status, parsed_json_or_text).
    On a certificate failure, retries with the next trusted certificate source (never unverified)."""
    while True:
        status, data = _upstream_once(path, body, timeout)
        if status == 0 and "CERTIFICATE_VERIFY_FAILED" in str(data) and next_cert_source():
            continue
        return status, data


def _upstream_once(path, body, timeout):
    url = STATE.base_url.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET")
    req.add_header("Authorization", f"Bearer {STATE.api_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = str(getattr(e, "reason", e))
        if "CERTIFICATE_VERIFY_FAILED" in reason:
            reason += (" — Python on this computer has no trusted certificates. Fix: run "
                       "'pip3 install certifi', or on macOS open Applications > Python 3.x and run "
                       "'Install Certificates.command', then restart server.py.")
        return 0, reason


def strip_thinking(text):
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()


def mock_reply(messages):
    """Stand-in model for offline testing. Clearly labelled; never used when a key is set."""
    user = messages[-1]["content"] if messages else ""
    try:
        payload = json.loads(user[user.index("{"):])
    except ValueError:
        return '{"ok": true}'
    if "intersections" in payload:
        out = []
        for row in payload["intersections"]:
            q_green, q_red = row["waiting_on_green"], row["waiting_on_red"]
            if row["green_for_s"] >= payload.get("min_green_s", 6) and q_red >= q_green + 3:
                out.append({"id": row["id"], "why": f"[mock] {q_red} waiting on {row['red_road']} vs {q_green} on {row['green_road']}"})
        return json.dumps({"switch": out[:6]})
    if "routes" in payload:
        best = min(payload["routes"], key=lambda r: r["est_s"])
        return json.dumps({"route": best["route"], "why": f"[mock] route {best['route']} has the lowest estimated time"})
    return '{"ok": true}'


def chat(model, messages, max_tokens=600, temperature=0.3, json_mode=False):
    t0 = time.time()
    if STATE.mock:
        time.sleep(0.25)
        content = mock_reply(messages)
        return 200, {"content": content, "latencyMs": int((time.time() - t0) * 1000), "model": f"mock:{model}", "usage": None}
    if not STATE.api_key:
        return 400, {"error": "No API key set. Open the settings and enter your Nebius Token Factory key."}
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    if STATE.no_thinking_ok:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    if json_mode and STATE.json_mode_ok:
        body["response_format"] = {"type": "json_object"}  # asks the endpoint for well-formed JSON
    status, data = upstream("/chat/completions", body, timeout=25)
    # if the endpoint rejects an optional setting, drop it for good and try once more
    for key, flag in (("response_format", "json_mode_ok"), ("chat_template_kwargs", "no_thinking_ok")):
        if status == 400 and key in body and key in json.dumps(data):
            setattr(STATE, flag, False)
            body.pop(key, None)
            status, data = upstream("/chat/completions", body, timeout=25)
    ms = int((time.time() - t0) * 1000)
    STATE.stats["calls"] += 1
    STATE.stats["last_ms"] = ms
    if status != 200 or not isinstance(data, dict) or not data.get("choices"):
        STATE.stats["errors"] += 1
        msg = data.get("error", {}).get("message") if isinstance(data, dict) and isinstance(data.get("error"), dict) else data
        STATE.stats["last_error"] = f"{status}: {str(msg)[:300]}"
        return 502, {"error": STATE.stats["last_error"], "latencyMs": ms}
    usage = data.get("usage") or {}
    STATE.stats["prompt_tokens"] += usage.get("prompt_tokens", 0) or 0
    STATE.stats["completion_tokens"] += usage.get("completion_tokens", 0) or 0
    STATE.stats["last_error"] = None
    msg = data["choices"][0].get("message", {})
    if json_mode and "{" not in (msg.get("content") or ""):
        print(f"[nemotron] reply without JSON from {model}: {(msg.get('content') or '')[:300]!r}", flush=True)
    return 200, {"content": strip_thinking(msg.get("content") or ""), "latencyMs": ms, "model": data.get("model", model), "usage": usage}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            return  # keep the console readable; model calls happen every few seconds
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("localhost", "127.0.0.1", "[::1]"):
            self._json(HTTPStatus.FORBIDDEN, {"error": "The UrbanFlow server only accepts requests from this computer."})
            return False
        return True

    def _json(self, status, obj):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 200_000:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def do_GET(self):
        # never serve the key file or other dotfiles, however the path is encoded
        from urllib.parse import unquote
        clean = unquote(self.path.split("?", 1)[0]).lower()
        if ".env" in clean or "/." in clean:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self.path.startswith("/api/"):
            return super().do_GET()
        if not self._local_only():
            return
        if self.path == "/api/status":
            return self._json(200, STATE.public())
        if self.path == "/api/models":
            if STATE.mock or not STATE.api_key:
                return self._json(200, {"models": KNOWN_MODELS, "source": "built-in list"})
            status, data = upstream("/models", timeout=15)
            if status == 200 and isinstance(data, dict):
                ids = sorted({m.get("id", "") for m in data.get("data", []) if m.get("id")})
                nv = [i for i in ids if "nemotron" in i.lower()]
                return self._json(200, {"models": nv or KNOWN_MODELS, "source": "Token Factory" if nv else "built-in list"})
            return self._json(200, {"models": KNOWN_MODELS, "source": "built-in list", "error": f"{status}: {str(data)[:200]}"})
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if not self.path.startswith("/api/") or not self._local_only():
            return self.send_error(HTTPStatus.NOT_FOUND)
        body = self._body()
        if body is None:
            return self._json(400, {"error": "Request body must be JSON."})
        if self.path == "/api/config":
            key = (body.get("apiKey") or "").strip()
            if key:
                STATE.api_key, STATE.key_source = key, "dashboard"
            if body.get("clearKey"):
                STATE.api_key, STATE.key_source = "", None
            for field, attr in (("baseUrl", "base_url"), ("signalModel", "signal_model"), ("dispatchModel", "dispatch_model")):
                if body.get(field):
                    setattr(STATE, attr, str(body[field]).strip())
            if body.get("saveToEnv"):
                write_env({
                    "NEBIUS_API_KEY": STATE.api_key, "NEBIUS_BASE_URL": STATE.base_url,
                    "NEMOTRON_SIGNAL_MODEL": STATE.signal_model, "NEMOTRON_DISPATCH_MODEL": STATE.dispatch_model,
                })
            return self._json(200, STATE.public())
        if self.path == "/api/chat":
            model = body.get("model") or STATE.signal_model
            status, data = chat(model, body.get("messages") or [], int(body.get("max_tokens") or 600), float(body.get("temperature") or 0.3), bool(body.get("json")))
            return self._json(status, data)
        if self.path == "/api/test":
            model = body.get("model") or STATE.signal_model
            status, data = chat(model, [{"role": "user", "content": 'Reply with exactly: {"ok": true}'}], 20, 0)
            return self._json(status, data)
        self.send_error(HTTPStatus.NOT_FOUND)


def main():
    global STATE
    ap = argparse.ArgumentParser(description="UrbanFlow AI local server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--mock", action="store_true", help="answer with a labelled stand-in model (no key, no network)")
    args = ap.parse_args()
    STATE = State(args.mock)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"UrbanFlow AI running at http://localhost:{args.port}")
    print("  model calls: " + ("MOCK (no key, no network)" if args.mock else f"{STATE.base_url}  key: {'from .env' if STATE.api_key else 'not set yet - add it in the dashboard settings'}"))
    if not args.mock:
        print(f"  HTTPS certificates: {SSL_SOURCE}")
    print("  stop with Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    sys.exit(main())
