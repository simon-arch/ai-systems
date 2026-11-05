from openai import (APIConnectionError, APIStatusError, APITimeoutError, BadRequestError, NotFoundError, OpenAI)
from prompt import CATEGORIES, SCHEMA, build_messages
import json
import os
import re
import time

BASE_URL = os.getenv("MODEL_BASE_URL", "http://localhost:11434/v1")
MODEL = os.getenv("MODEL_NAME", "qwen3.5:9b")
TEMPERATURE = float(os.getenv("TEMPERATURE", "0"))
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "200"))
TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "60"))
SEED = int(os.getenv("SEED", "1"))
REASONING_EFFORT = os.getenv("REASONING_EFFORT", "none")

THRESHOLDS = {"soft": (2, 3), "standard": (1, 3), "strict": (1, 2)}

class ModerationError(Exception):
    def __init__(self, code, message, raw=""):
        super().__init__(message)
        self.code = code
        self.raw = raw

def make_client(timeout=TIMEOUT):
    return OpenAI(base_url=BASE_URL, api_key="local", timeout=timeout, max_retries=0)

def parse_result(buf, finish_reason):
    text = buf.strip()
    match = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(match.group(0) if match else text)
        severity = int(data["severity"])
        if severity not in (0, 1, 2, 3):
            raise ValueError("severity")
        categories = [c for c in data.get("categories", []) if c in CATEGORIES]
        reason = str(data.get("reason", "")).strip()

    except (ValueError, KeyError, TypeError):
        if finish_reason == "length":
            raise ModerationError("truncated", "Відповідь моделі обмежено лімітом токенів.", raw=buf)
        raise ModerationError("bad_json", "Невірний формат відповіді.", raw=buf)

    return {"reason": reason, "categories": categories, "severity": severity}

def decide(result, strictness):
    warn_at, block_at = THRESHOLDS.get(strictness, THRESHOLDS["standard"])
    sev = result["severity"]
    action = "block" if sev >= block_at else "warn" if sev >= warn_at else "allow"
    return {**result, "action": action}

def _run(client, messages, use_schema, strictness):
    kwargs = dict(model=MODEL, messages=messages, temperature=TEMPERATURE, max_tokens=MAX_TOKENS, seed=SEED, stream=True, stream_options={"include_usage": True})

    if REASONING_EFFORT:
        kwargs["extra_body"] = {"reasoning_effort": REASONING_EFFORT}

    if use_schema:
        kwargs["response_format"] = {"type": "json_schema", "json_schema": {"name": "moderation", "schema": SCHEMA, "strict": True}}

    start = time.perf_counter()
    first = usage = finish = None
    chunks = 0
    buf = ""
    stream = client.chat.completions.create(**kwargs)

    try:
        for chunk in stream:
            if chunk.usage:
                usage = chunk.usage

            if not chunk.choices:
                continue

            choice = chunk.choices[0]
            piece = choice.delta.content or ""

            if piece:
                if first is None:
                    first = time.perf_counter()
                buf += piece
                chunks += 1
                yield "token", piece

            if choice.finish_reason:
                finish = choice.finish_reason
    finally:
        stream.close()

    end = time.perf_counter()
    if finish == "error":
        raise ModerationError("generation_error", "Сервер моделі повідомив про помилку.", raw=buf)

    result = decide(parse_result(buf, finish), strictness)
    tokens = usage.completion_tokens if usage else chunks
    gen_time = (end - first) if first else 0
    result["stats"] = {
        "seconds": round(end - start, 2),
        "ttft": round(first - start, 2) if first else None,
        "tokens": tokens,
        "tokens_per_s": round(tokens / gen_time, 1) if gen_time > 0 else None,
    }
    yield "result", result

def stream_moderation(client, text, history, strictness="standard"):
    messages = build_messages(text, history)
    try:
        try:
            yield from _run(client, messages, True, strictness)
        except BadRequestError:
            yield from _run(client, messages, False, strictness)

    except APITimeoutError:
        raise ModerationError("timeout", f"Модель не відповіла за {TIMEOUT:.0f} с.")

    except APIConnectionError:
        raise ModerationError("unreachable", f"Не вдалося підключитися до {BASE_URL}.")

    except NotFoundError:
        raise ModerationError("model_not_found", f"Модель {MODEL} не знайдена.")

    except APIStatusError as e:
        raise ModerationError("api_error", f"Сервер моделі повернув помилку {e.status_code}.")

def loaded_model(client=None):
    return MODEL

def check_health():
    try:
        ids = [m.id for m in make_client(timeout=3).models.list().data]

    except APIConnectionError:
        return False, f"Немає зв'язку"

    except APIStatusError as e:
        return False, f"Сервер моделі повернув помилку {e.status_code}."

    if not any(i == MODEL or i.split(":")[0] == MODEL for i in ids):
        return False, f"Модель не завантажена"

    return True, MODEL