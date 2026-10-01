#!/usr/bin/env python3
import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_dotenv(ROOT / ".env")

API_BASE = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8787"))


class OpenAIAPIError(Exception):
    def __init__(self, status: int, payload):
        super().__init__(f"OpenAI API error {status}")
        self.status = status
        self.payload = payload


def openai_headers():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise OpenAIAPIError(500, {"error": {"message": "Falta OPENAI_API_KEY en .env o en el entorno."}})
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if os.getenv("OPENAI_PROJECT"):
        headers["OpenAI-Project"] = os.environ["OPENAI_PROJECT"]
    if os.getenv("OPENAI_ORGANIZATION"):
        headers["OpenAI-Organization"] = os.environ["OPENAI_ORGANIZATION"]
    return headers


def openai_request(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(f"{API_BASE}{path}", data=data, headers=openai_headers(), method=method)
    try:
        with urlopen(req, timeout=120) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": {"message": raw or str(exc)}}
        raise OpenAIAPIError(exc.code, payload) from exc
    except URLError as exc:
        raise OpenAIAPIError(502, {"error": {"message": f"No se pudo conectar con OpenAI: {exc.reason}"}}) from exc


def retrieve_response(response_id: str):
    return openai_request("GET", f"/responses/{quote(response_id, safe='')}?include%5B%5D=file_search_call.results")


def retrieve_input_items(response_id: str):
    return openai_request("GET", f"/responses/{quote(response_id, safe='')}/input_items?limit=100&order=asc")


def build_chain(response_id: str, limit: int):
    nodes = []
    seen = set()
    current = response_id
    truncated = False

    while current and len(nodes) < limit:
        if current in seen:
            raise OpenAIAPIError(409, {"error": {"message": f"Bucle detectado en previous_response_id: {current}"}})
        seen.add(current)
        response = retrieve_response(current)
        try:
            input_items = retrieve_input_items(current).get("data", [])
            input_items_error = None
        except OpenAIAPIError as exc:
            input_items = []
            input_items_error = exc.payload
        nodes.append({
            "response": response,
            "input_items": input_items,
            "input_items_error": input_items_error,
        })
        current = response.get("previous_response_id")

    if current:
        truncated = True

    nodes.reverse()
    return {"chain": nodes, "truncated": truncated, "limit": limit}


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenAIResponseDebugger/1.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status: int, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            raise ValueError("Body demasiado grande")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                return self.send_json(200, {
                    "ok": True,
                    "runtime": "python",
                    "api_key_configured": bool(os.getenv("OPENAI_API_KEY")),
                    "api_base": API_BASE,
                })

            if parsed.path == "/api/chain":
                qs = parse_qs(parsed.query)
                response_id = (qs.get("response_id") or [""])[0].strip()
                if not response_id:
                    return self.send_json(400, {"error": {"message": "Falta response_id"}})
                try:
                    limit = max(1, min(100, int((qs.get("limit") or ["30"])[0])))
                except ValueError:
                    limit = 30
                return self.send_json(200, build_chain(response_id, limit))

            if parsed.path == "/api/response":
                qs = parse_qs(parsed.query)
                response_id = (qs.get("response_id") or [""])[0].strip()
                if not response_id:
                    return self.send_json(400, {"error": {"message": "Falta response_id"}})
                response = retrieve_response(response_id)
                items = retrieve_input_items(response_id)
                return self.send_json(200, {"response": response, "input_items": items.get("data", [])})

            return self.serve_static(parsed.path)
        except OpenAIAPIError as exc:
            return self.send_json(exc.status, exc.payload)
        except Exception as exc:
            return self.send_json(500, {"error": {"message": str(exc)}})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/continue":
            return self.send_json(404, {"error": {"message": "Not found"}})

        try:
            payload = self.read_json()
            previous_id = str(payload.get("previous_response_id") or "").strip()
            user_input = payload.get("input")
            model = str(payload.get("model") or "").strip()
            instructions = payload.get("instructions")
            store = bool(payload.get("store", True))
            overrides = payload.get("overrides") or {}

            if not previous_id:
                return self.send_json(400, {"error": {"message": "Falta previous_response_id"}})
            if not isinstance(user_input, str) or not user_input.strip():
                return self.send_json(400, {"error": {"message": "input debe ser texto no vacío"}})
            if not isinstance(overrides, dict):
                return self.send_json(400, {"error": {"message": "overrides debe ser un objeto JSON"}})

            if not model:
                parent = retrieve_response(previous_id)
                model = parent.get("model") or "gpt-5.6"

            protected = {"previous_response_id", "input", "model", "instructions", "store", "conversation"}
            body = {k: v for k, v in overrides.items() if k not in protected}
            body.update({
                "model": model,
                "previous_response_id": previous_id,
                "input": user_input,
                "store": store,
            })
            if isinstance(instructions, str) and instructions.strip():
                body["instructions"] = instructions

            response = openai_request("POST", "/responses", body)
            return self.send_json(200, {"response": response, "request_body": body})
        except json.JSONDecodeError:
            return self.send_json(400, {"error": {"message": "JSON inválido"}})
        except OpenAIAPIError as exc:
            return self.send_json(exc.status, exc.payload)
        except Exception as exc:
            return self.send_json(500, {"error": {"message": str(exc)}})

    def serve_static(self, request_path: str):
        relative = "index.html" if request_path == "/" else request_path.lstrip("/")
        candidate = (WEB_DIR / relative).resolve()
        if WEB_DIR.resolve() not in candidate.parents and candidate != WEB_DIR.resolve():
            return self.send_json(403, {"error": {"message": "Forbidden"}})
        if not candidate.is_file():
            return self.send_json(404, {"error": {"message": "Not found"}})
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"OpenAI Response Debugger (Python) -> http://{HOST}:{PORT}")
    print(f"API base: {API_BASE}")
    print("Ctrl+C para detener.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
