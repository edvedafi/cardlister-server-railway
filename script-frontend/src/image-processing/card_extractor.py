#!/usr/bin/env python3
"""
card_extractor.py

Standalone card info extraction using vision AI (Claude Haiku or Ollama).
Extracts player name, team, and card number from card images without a catalog.

Backend selection (auto-detected at runtime):
  OLLAMA_HOST env var set → use local Ollama model (free, fast on Apple Silicon/GPU)
  else                    → use Claude Haiku 4.5 API (~$0.001/card pair)

Protocol (newline-delimited JSON over stdin/stdout):
  Pair request:   {"front": "/path/to/front.jpg", "back": "/path/to/back.jpg", "id": "optional-id"}
  Single request: {"image": "/path/to/card.jpg", "id": "optional-id"}
  Pair response:   {"id": "...", "player": "Patrick Mahomes", "team": "Kansas City Chiefs", "card_number": "BC-15"}
  Single response: {"id": "...", "player": "...", "team": "...", "card_number": "...", "side": "front"|"back"}
  Error:           {"id": "...", "error": "description"}

  Special:  {"cmd": "ping"}   ->  {"status": "ok"}
            {"cmd": "quit"}   ->  process exits

CLI mode:
  python card_extractor.py <front_image> <back_image>     # pair extraction
  python card_extractor.py --single <image>                # single-image extraction
  Output: {"player": "...", "team": "...", "card_number": "...", "side": "front"|"back"}
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


# ── Result cache (bounded LRU) ───────────────────────────────────────────────

from collections import OrderedDict

MAX_CACHE_SIZE = 200


class _LRUCache(OrderedDict):
    def __setitem__(self, key, value):
        if key in self:
            self.move_to_end(key)
        super().__setitem__(key, value)
        if len(self) > MAX_CACHE_SIZE:
            self.popitem(last=False)


_cache = _LRUCache()


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
    "3. card_number: The card number as printed on the BACK of the card (e.g. \"BC-15\", \"123\") (null if not visible). Do not use jersey numbers or stats from the front.\n\n"
    "Be precise. Only return what is clearly visible on the card."
)

SINGLE_IMAGE_PROMPT = (
    "Examine this single trading card image and extract:\n"
    "1. player: The player's full name (null if not identifiable)\n"
    "2. team: The team name (null if not identifiable)\n"
    "3. card_number: The card number as printed (e.g. \"BC-15\", \"123\") (null if not visible)\n"
    "4. side: \"front\" if this shows the player photo/action shot, \"back\" if this shows "
    "statistics, biography text, or copyright information\n\n"
    "Be precise. Only return what is clearly visible on the card."
)

# Tool schema for structured extraction (pair mode)
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

# Tool schema for single-image extraction (includes side classification)
_EXTRACT_SINGLE_TOOL = {
    "name": "extract_single_card_info",
    "description": "Extract player name, team, card number, and front/back classification from a single trading card image",
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
            "side": {
                "type": "string",
                "enum": ["front", "back"],
                "description": "Whether this is the front (player photo) or back (stats/bio) of the card",
            },
        },
        "required": ["player", "team", "card_number", "side"],
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


def extract_single_with_claude(image_path: str) -> dict:
    """Extract card info + side from a single image using Claude Haiku 4.5."""
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic package not installed. Run: pip install anthropic")

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY environment variable not set")

    client = anthropic.Anthropic(api_key=api_key)
    img_b64, img_mt = encode_image(image_path)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        system=SYSTEM_PROMPT,
        tools=[_EXTRACT_SINGLE_TOOL],
        tool_choice={"type": "tool", "name": "extract_single_card_info"},
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": img_mt, "data": img_b64},
                },
                {"type": "text", "text": SINGLE_IMAGE_PROMPT},
            ],
        }],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "extract_single_card_info":
            inp = block.input
            side = inp.get("side", "front")
            return {
                "player": inp.get("player") or None,
                "team": inp.get("team") or None,
                # Card numbers are only on the back; ignore any value from fronts
                "card_number": (inp.get("card_number") or None) if side == "back" else None,
                "side": side,
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
    Prefers the front for player/team (usually clearer there).
    Card number is taken exclusively from the back — it is not printed on
    card fronts, and vision models often hallucinate jersey numbers or stats.
    """
    def pick(front_val, back_val, prefer_front: bool):
        if front_val and back_val:
            return front_val if prefer_front else back_val
        return front_val or back_val

    return {
        "player":      pick(front.get("player"),      back.get("player"),      prefer_front=True),
        "team":        pick(front.get("team"),         back.get("team"),        prefer_front=True),
        "card_number": back.get("card_number") or None,
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
        front_result = front_future.result(timeout=90)
        back_result  = back_future.result(timeout=90)

    return _merge_results(front_result, back_result)


def _ollama_request_raw(image_b64: str, prompt: str, ollama_host: str, ollama_model: str) -> dict:
    """Send a single image to Ollama and return the full parsed JSON result (all fields)."""
    import urllib.request

    payload = {
        "model": ollama_model,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
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
    except Exception as e:
        raise RuntimeError(f"Failed to connect to Ollama at {ollama_host}: {e}")

    content = result.get("message", {}).get("content", "")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        raise RuntimeError(f"Ollama returned non-JSON content: {content!r}")


def extract_single_with_ollama(image_path: str) -> dict:
    """Extract card info + side from a single image using local Ollama."""
    ollama_host = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
    ollama_model = os.environ.get('OLLAMA_MODEL', 'llama3.2-vision:11b')

    prompt = (
        SINGLE_IMAGE_PROMPT + "\n\n"
        "Respond with ONLY a JSON object in this exact format (no markdown, no explanation):\n"
        '{"player": "Full Name or null", "team": "Team Name or null", '
        '"card_number": "BC-15 or null", "side": "front or back"}'
    )

    img_b64, _ = encode_image(image_path)
    parsed = _ollama_request_raw(img_b64, prompt, ollama_host, ollama_model)

    side = parsed.get("side", "front")
    if side not in ("front", "back"):
        side = "front"

    return {
        "player": parsed.get("player") or None,
        "team": parsed.get("team") or None,
        # Card numbers are only on the back; ignore any value from fronts
        "card_number": (parsed.get("card_number") or None) if side == "back" else None,
        "side": side,
    }


# ── Core extraction with caching and retries ─────────────────────────────────

MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0  # seconds


def _single_cache_key(image_path: str) -> str:
    """Cache key for a single image based on path and modification time."""
    try:
        sig = f"{image_path}:{os.stat(image_path).st_mtime}"
    except OSError:
        sig = image_path
    return hashlib.md5(sig.encode()).hexdigest()


def extract_single_card_info(image_path: str) -> dict:
    """
    Extract card info + front/back side from a single image.
    Results are cached by file path + mtime. Transient errors are retried.
    """
    key = _single_cache_key(image_path)
    if key in _cache:
        return _cache[key]

    if not Path(image_path).exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    use_ollama = bool(os.environ.get('OLLAMA_HOST'))
    backend_fn = extract_single_with_ollama if use_ollama else extract_single_with_claude

    last_error: Exception = RuntimeError("No attempts made")
    for attempt in range(MAX_RETRIES):
        try:
            result = backend_fn(image_path)
            _cache[key] = result
            return result
        except (FileNotFoundError, RuntimeError) as e:
            msg = str(e)
            if "not found" in msg.lower() or "API_KEY" in msg or "not installed" in msg:
                raise
            last_error = e
        except Exception as e:
            last_error = e

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_BASE_DELAY * (2 ** attempt))

    raise last_error


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
    # Warm up heavy native libraries BEFORE signaling ready.
    # This avoids a massive dlopen storm on the first request that can crash dyld
    # on macOS Sequoia with large venvs (torch, cv2, scipy, etc.).
    try:
        from PIL import Image  # noqa: F401
        sys.stderr.write("[card-extractor] PIL loaded\n")
    except ImportError:
        pass

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

        req_id = request.get("id")
        single_image = request.get("image", "")
        front = request.get("front", "")
        back = request.get("back", "")

        if single_image:
            # Single-image extraction mode
            try:
                result = extract_single_card_info(single_image)
                response: dict = {
                    "player": result.get("player"),
                    "team": result.get("team"),
                    "card_number": result.get("card_number"),
                    "side": result.get("side"),
                }
            except Exception as e:
                response = {"error": str(e)}
        elif front and back:
            # Pair extraction mode
            try:
                result = extract_card_info(front, back)
                response = {
                    "player": result.get("player"),
                    "team": result.get("team"),
                    "card_number": result.get("card_number"),
                }
            except Exception as e:
                response = {"error": str(e)}
        else:
            response = {"error": "Provide 'image' for single extraction or both 'front' and 'back' for pair extraction"}

        if req_id is not None:
            response["id"] = req_id

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == '--single':
        # CLI mode: python card_extractor.py --single <image>
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Usage: card_extractor.py --single <image>"}))
            os._exit(1)
        image_path = sys.argv[2]
        try:
            result = extract_single_card_info(image_path)
            print(json.dumps(result))
            sys.stdout.flush()
            os._exit(0)
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            os._exit(1)

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
            sys.stdout.flush()
            os._exit(0)
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            os._exit(1)

    if len(sys.argv) == 2:
        print(json.dumps({"error": "Usage: card_extractor.py [--single] <image> | <front_image> <back_image>"}))
        os._exit(1)

    # No args → persistent worker mode
    run_worker()
    os._exit(0)  # skip Py_FinalizeEx — avoids PyTorch/C-extension segfault during module cleanup


if __name__ == "__main__":
    main()
