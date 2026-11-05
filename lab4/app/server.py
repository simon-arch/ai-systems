from flask import Flask, Response, jsonify, request, stream_with_context
import moderation as mod
import json
import os

MAX_CHARS = 1000
MAX_HISTORY = 6

app = Flask(__name__, static_folder="static", static_url_path="")
app.json.ensure_ascii = False
client = mod.make_client()

def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

@app.get("/")
def index():
    return app.send_static_file("index.html")

@app.get("/api/health")
def health():
    ok, message = mod.check_health()
    return jsonify(ok=ok, model=mod.MODEL, message=message)

@app.post("/api/moderate")
def moderate():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()

    if not text:
        return jsonify(code="empty", message="Повідомлення порожнє."), 400

    if len(text) > MAX_CHARS:
        return jsonify(code="too_long", message=f"Повідомлення довше за {MAX_CHARS} символів."), 400

    strictness = data.get("strictness") if data.get("strictness") in mod.THRESHOLDS else "standard"
    raw_history = data.get("history") if isinstance(data.get("history"), list) else []
    history = [str(h.get("text", ""))[:MAX_CHARS] for h in raw_history[-MAX_HISTORY:] if isinstance(h, dict)]

    def generate():
        try:
            for kind, payload in mod.stream_moderation(client, text, history, strictness):
                yield sse(kind, {"t": payload} if kind == "token" else payload)
        except mod.ModerationError as e:
            yield sse("error", {"code": e.code, "message": str(e), "raw": e.raw})

    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    print(f"Runtime: {mod.BASE_URL}\nUrl: http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, threaded=True)
