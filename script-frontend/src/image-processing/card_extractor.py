#!/usr/bin/env python3
"""
card_extractor.py

Standalone card info extraction using vision AI (Claude Haiku or Ollama).
Extracts player name, team, and card number from card images without a catalog.

Backend selection (auto-detected at runtime):
  OLLAMA_HOST env var set → use local Ollama model (free, fast on Apple Silicon/GPU)
  else                    → use Claude Haiku 4.5 API (~$0.001/card pair)

Protocol (newline-delimited JSON over stdin/stdout):
  Request:  {"front": "/path/to/front.jpg", "back": "/path/to/back.jpg", "id": "optional-id"}
  Response: {"id": "...", "player": "Patrick Mahomes", "team": "Kansas City Chiefs", "card_number": "BC-15"}
  Error:    {"id": "...", "error": "description"}

  Special:  {"cmd": "ping"}   ->  {"status": "ok"}
            {"cmd": "quit"}   ->  process exits

CLI mode (single card):
  python card_extractor.py <front_image> <back_image>
  Output: {"player": "...", "team": "...", "card_number": "..."}
"""

import sys
import json
import os
import time
import hashlib
import base64
import signal
import faulthandler
from pathlib import Path
from io import BytesIO

# Enable Python-level stack traces on fatal signals
faulthandler.enable()


def _emergency_exit(signum, frame):
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(1)


signal.signal(signal.SIGTERM, _emergency_exit)
if hasattr(signal, 'SIGBUS'):
    signal.signal(signal.SIGBUS, _emergency_exit)


# ── Image utilities ──────────────────────────────────────────────────────────

MAX_IMAGE_SIDE = 1500  # Resize images to this max dimension before encoding


def load_and_resize_image(image_path: str):
    """Load image, resize if needed. Returns (jpeg_bytes, media_type)."""
    try:
        from PIL import Image
        img = Image.open(image_path)
        img = img.convert('RGB')

        w, h = img.size
        if w > MAX_IMAGE_SIDE or h > MAX_IMAGE_SIDE:
            ratio = min(MAX_IMAGE_SIDE / w, MAX_IMAGE_SIDE / h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

        buf = BytesIO()
        img.save(buf, format='JPEG', quality=85)
        return buf.getvalue(), 'image/jpeg'

    except ImportError:
        # Pillow not available — read raw bytes, detect type by extension
        with open(image_path, 'rb') as f:
            data = f.read()
        ext = Path(image_path).suffix.lower()
        media_type = {
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
        }.get(ext, 'image/jpeg')
        return data, media_type


def encode_image(image_path: str):
    """Return (base64_string, media_type) for an image file."""
    data, media_type = load_and_resize_image(image_path)
    return base64.standard_b64encode(data).decode('utf-8'), media_type


# ── Result cache ─────────────────────────────────────────────────────────────

_cache: dict = {}


def _cache_key(front: str, back: str) -> str:
    """Cache key based on file paths and modification times."""
    def sig(path: str) -> str:
        try:
            return f"{path}:{os.stat(path).st_mtime}"
        except OSError:
            return path

    raw = f"{sig(front)}|{sig(back)}"
    return hashlib.md5(raw.encode()).hexdigest()


# ── Prompts ──────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are a trading card expert. Extract information exactly as printed on the card."
)

USER_PROMPT = (
    "Examine these trading card images (front and back) and extract:\n"
    "1. player: The player's full name (null if not identifiable)\n"
    "2. team: The team name (null if not identifiable)\n"
    "3. card_number: The card number as printed (e.g. \"BC-15\", \"123\") (null if not visible)\n\n"
    "Be precise. Only return what is clearly visible on the card."
)

# Tool schema for structured extraction
_EXTRACT_TOOL = {
    "name": "extract_card_info",
    "description": "Extract player name, team, and card number from trading card images",
    "input_schema": {
        "type": "object",
        "properties": {
            "player": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "description": "Full name of the player, or null if not identifiable",
            },
            "team": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "description": "Team name, or null if not identifiable",
            },
            "card_number": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "description": 'Card number as printed (e.g. "BC-15", "123"), or null if not visible',
            },
        },
        "required": ["player", "team", "card_number"],
    },
}


# ── Claude Haiku backend ─────────────────────────────────────────────────────

def extract_with_claude(front_path: str, back_path: str) -> dict:
    """Extract card info using Claude Haiku 4.5 with forced tool use."""
    try:
        import anthropic
    except ImportError:
        raise RuntimeError(
            "anthropic package not installed. Run: pip install anthropic"
        )

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY environment variable not set")

    client = anthropic.Anthropic(api_key=api_key)

    front_b64, front_mt = encode_image(front_path)
    back_b64, back_mt = encode_image(back_path)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        system=SYSTEM_PROMPT,
        tools=[_EXTRACT_TOOL],
        tool_choice={"type": "tool", "name": "extract_card_info"},
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": front_mt,
                        "data": front_b64,
                    },
                },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": back_mt,
                        "data": back_b64,
                    },
                },
                {"type": "text", "text": USER_PROMPT},
            ],
        }],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "extract_card_info":
            inp = block.input
            return {
                "player": inp.get("player") or None,
                "team": inp.get("team") or None,
                "card_number": inp.get("card_number") or None,
            }

    raise RuntimeError("No tool_use block in Claude response")


# ── Ollama backend ───────────────────────────────────────────────────────────

def _ollama_request(image_b64: str, prompt: str, ollama_host: str, ollama_model: str) -> dict:
    """Send a single image to Ollama and return parsed JSON result."""
    import urllib.request
    import urllib.error

    payload = {
        "model": ollama_model,
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [image_b64],
        }],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        f"{ollama_host}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to connect to Ollama at {ollama_host}: {e}")

    content = result.get("message", {}).get("content", "")

    try:
        parsed = json.loads(content)
        return {
            "player": parsed.get("player") or None,
            "team": parsed.get("team") or None,
            "card_number": parsed.get("card_number") or None,
        }
    except json.JSONDecodeError:
        raise RuntimeError(f"Ollama returned non-JSON content: {content!r}")


def _merge_results(front: dict, back: dict) -> dict:
    """
    Merge extraction results from front and back images.
    Prefers the front for player/team (usually clearer there) and the back
    for card_number (usually printed there), but falls back to whichever
    side has the value when the preferred side has none.
    If both sides found a value and they differ, prefer front for player/team
    and back for card_number.
    """
    def pick(front_val, back_val, prefer_front: bool):
        if front_val and back_val:
            return front_val if prefer_front else back_val
        return front_val or back_val

    return {
        "player":      pick(front.get("player"),      back.get("player"),      prefer_front=True),
        "team":        pick(front.get("team"),         back.get("team"),        prefer_front=True),
        "card_number": pick(front.get("card_number"),  back.get("card_number"), prefer_front=False),
    }


def extract_with_ollama(front_path: str, back_path: str) -> dict:
    """Extract card info using a local Ollama vision model.

    Makes two separate requests (one per image) because most vision models
    only support a single image per request. Requests are fired in parallel
    using threads. Results are merged, preferring the front for player/team
    and the back for card_number, but checking both sides for all fields.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ollama_host = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
    ollama_model = os.environ.get('OLLAMA_MODEL', 'llama3.2-vision:11b')

    prompt = (
        USER_PROMPT + "\n\n"
        "Respond with ONLY a JSON object in this exact format (no markdown, no explanation):\n"
        '{"player": "Full Name or null", "team": "Team Name or null", "card_number": "BC-15 or null"}'
    )

    front_b64, _ = encode_image(front_path)
    back_b64, _ = encode_image(back_path)

    with ThreadPoolExecutor(max_workers=2) as executor:
        front_future = executor.submit(_ollama_request, front_b64, prompt, ollama_host, ollama_model)
        back_future  = executor.submit(_ollama_request, back_b64,  prompt, ollama_host, ollama_model)
        front_result = front_future.result()
        back_result  = back_future.result()

    return _merge_results(front_result, back_result)


# ── Core extraction with caching and retries ─────────────────────────────────

MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0  # seconds


def extract_card_info(front_path: str, back_path: str) -> dict:
    """
    Extract card info using the configured backend.
    Results are cached by file path + mtime. Transient errors are retried.
    """
    key = _cache_key(front_path, back_path)
    if key in _cache:
        return _cache[key]

    # Validate files exist before hitting the API
    if not Path(front_path).exists():
        raise FileNotFoundError(f"Front image not found: {front_path}")
    if not Path(back_path).exists():
        raise FileNotFoundError(f"Back image not found: {back_path}")

    use_ollama = bool(os.environ.get('OLLAMA_HOST'))
    backend_fn = extract_with_ollama if use_ollama else extract_with_claude

    last_error: Exception = RuntimeError("No attempts made")
    for attempt in range(MAX_RETRIES):
        try:
            result = backend_fn(front_path, back_path)
            _cache[key] = result
            return result
        except (FileNotFoundError, RuntimeError) as e:
            msg = str(e)
            # Don't retry permanent failures
            if "not found" in msg.lower() or "API_KEY" in msg or "not installed" in msg:
                raise
            last_error = e
        except Exception as e:
            last_error = e

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_BASE_DELAY * (2 ** attempt))

    raise last_error


# ── Persistent worker mode ───────────────────────────────────────────────────

def run_worker():
    """
    Read newline-delimited JSON from stdin, write JSON responses to stdout.
    Keeps the process (and any warmed-up state) alive between requests.
    """
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({"error": "Invalid JSON"}) + "\n")
            sys.stdout.flush()
            continue

        # Special commands
        cmd = request.get("cmd")
        if cmd == "ping":
            sys.stdout.write(json.dumps({"status": "ok"}) + "\n")
            sys.stdout.flush()
            continue
        if cmd == "quit":
            break

        front = request.get("front", "")
        back = request.get("back", "")
        req_id = request.get("id")

        if not front or not back:
            response: dict = {"error": "Both 'front' and 'back' image paths are required"}
            if req_id is not None:
                response["id"] = req_id
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        try:
            result = extract_card_info(front, back)
            response = {
                "player": result.get("player"),
                "team": result.get("team"),
                "card_number": result.get("card_number"),
            }
        except Exception as e:
            response = {"error": str(e)}

        if req_id is not None:
            response["id"] = req_id

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) >= 3:
        # CLI mode: python card_extractor.py <front> <back>
        front_path = sys.argv[1]
        back_path = sys.argv[2]
        try:
            result = extract_card_info(front_path, back_path)
            print(json.dumps({
                "player": result.get("player"),
                "team": result.get("team"),
                "card_number": result.get("card_number"),
            }))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
        return

    if len(sys.argv) == 2:
        print(json.dumps({"error": "Usage: card_extractor.py <front_image> <back_image>"}))
        sys.exit(1)

    # No args → persistent worker mode
    run_worker()


if __name__ == "__main__":
    main()
