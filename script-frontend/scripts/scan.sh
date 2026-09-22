#!/usr/bin/env bash
# scan.sh
# Continuous duplex card scanning from a Fujitsu fi-7160 (SANE / sane-backends)
# into input/<category>.
#
# Runs until you press Ctrl-C: scans whatever is in the ADF, saves the images,
# then waits for you to load the next batch and scans again.
#
# Usage:  yarn scan <category> [-o]   e.g.  yarn scan prestige
#                                          yarn scan prestige -o

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
  cat << 'USAGE'
[scan] usage: yarn scan <category> [-o]

  <category>   folder under input/ to write into (e.g. prestige)
  -o           raw mode, for cards the default crops too tightly. Turns OFF
               hardware deskew/crop and turns ON overscan, giving the full
               110x130mm frame with the card floating in it and background
               margin on all four sides. Output is ~3x larger, tilted as fed,
               and rotated 180 -- your pipeline has to straighten it.

  By default the scanner deskews, auto-orients and crops to the card edges,
  producing a straight, upright ~996x1390 image.
USAGE
}

CATEGORY=""
RAW_FLAG=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o | --raw | --overscan)
      RAW_FLAG=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "[scan] unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$CATEGORY" ]; then
        echo "[scan] unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      CATEGORY="$1"
      ;;
  esac
  shift
done

if [ -z "$CATEGORY" ]; then
  usage >&2
  exit 1
fi

DEST="$PROJECT_DIR/input/$CATEGORY"

# ── Scan settings ─────────────────────────────────────────────────────────────
# Geometry is deliberately MUCH larger than a 2.5x3.5in (63.5x88.9mm) card, for
# two reasons:
#
#   1. A card skewed 10deg in the feeder needs a ~78x99mm bounding box. Anything
#      tighter silently clips the corners and produces plausible-looking but
#      incomplete images -- worse than an outright failure.
#   2. In raw mode (-o) overscan shifts the card down and to the right inside
#      the window. At 90x110mm that shift pushed cards off the right and bottom
#      edges; 110x130mm leaves enough slack to absorb it.
#
# So do NOT shrink these -- geometry, deskew/crop and overscan are coupled, and
# the resulting clipping is silent.
SCAN_RES="${SCAN_RES:-400}"
SCAN_PAGE_W="${SCAN_PAGE_W:-110}"       # mm
SCAN_PAGE_H="${SCAN_PAGE_H:-130}"       # mm
SCAN_SOURCE="${SCAN_SOURCE:-ADF Duplex}"
SCAN_MODE="${SCAN_MODE:-Color}"
# Tone. At 0/0 the fi-7160 applies a steep curve that clips both ends (~18% of
# the card at L<=10, ~6% blown pure white), which crushes dark navy ink toward
# black. Negative contrast decompresses both ends.
SCAN_BRIGHTNESS="${SCAN_BRIGHTNESS:-0}"   # -127..127
SCAN_CONTRAST="${SCAN_CONTRAST:-0}"       # -127..127
# Hardware deskew + crop. The scanner finds the card's real edges, straightens
# it, auto-orients it, and crops to the card (~996x1390 at 400dpi). This is the
# default because it beats the alternative on every axis: straight instead of
# tilted, upright instead of rotated 180, and ~3x smaller.
#
# NOTE: it needs room to work. At a 70x95mm window the card filled the frame,
# so the "detected paper bounds" were just the window bounds and it silently
# did nothing. It only crops properly at a window well larger than the card.
SCAN_DESKEWCROP="${SCAN_DESKEWCROP:-yes}"
# Collects background BEFORE the paper's leading edge, so there is margin on all
# four sides. Pointless alongside deskew/crop, which crops that margin straight
# back off -- the two produce byte-identical geometry. Only used in raw mode.
SCAN_OVERSCAN="${SCAN_OVERSCAN:-Off}"

# -o = raw mode: skip deskew/crop, keep the whole frame plus overscan margin.
if [ "$RAW_FLAG" -eq 1 ]; then
  SCAN_DESKEWCROP="no"
  SCAN_OVERSCAN="On"
fi
POLL_SECONDS="${POLL_SECONDS:-3}"

# ── Preflight ─────────────────────────────────────────────────────────────────

if ! command -v scanimage > /dev/null 2>&1; then
  echo "[scan] scanimage not found. Install it with: brew install sane-backends" >&2
  exit 1
fi

if pgrep -qif vuescan 2> /dev/null; then
  echo "[scan] VueScan is running. The fi-7160 is exclusive-access USB, so SANE" >&2
  echo "[scan] cannot open it until VueScan quits. Quit VueScan and retry." >&2
  exit 1
fi

DEVICE="${SCANNER_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  echo "[scan] looking for scanner..."
  DEVICE="$(scanimage -f '%d%n' 2>/dev/null | grep '^fujitsu:' | head -1 || true)"
fi

if [ -z "$DEVICE" ]; then
  echo "[scan] No Fujitsu scanner found. Check that it is powered on and connected." >&2
  echo "[scan] 'scanimage -L' lists what SANE can see." >&2
  exit 1
fi

mkdir -p "$DEST"

echo "[scan] device:   $DEVICE"
echo "[scan] output:   $DEST"
if [ "$RAW_FLAG" -eq 1 ]; then
  echo "[scan] settings: $SCAN_SOURCE, $SCAN_MODE, ${SCAN_RES}dpi, RAW MODE (${SCAN_PAGE_W}x${SCAN_PAGE_H}mm frame, overscan on, no deskew/crop)"
else
  echo "[scan] settings: $SCAN_SOURCE, $SCAN_MODE, ${SCAN_RES}dpi, deskew+crop to card edges"
fi
echo "[scan] Load cards in the feeder. Press Ctrl-C to stop."
echo

STAGE="$(mktemp -d)"

# ── Helpers ───────────────────────────────────────────────────────────────────

# Highest NNNN already used in DEST, across every date prefix, so we never
# collide with or overwrite an existing scan.
next_index() {
  local max=0 n f
  shopt -s nullglob
  for f in "$DEST"/*.jpg; do
    n="$(basename "$f" .jpg)"
    n="${n##*-}"
    if [[ "$n" =~ ^[0-9]+$ ]]; then
      n=$((10#$n))
      [ "$n" -gt "$max" ] && max="$n"
    fi
  done
  echo $((max + 1))
}

# Move a completed batch out of staging and into DEST. Staging means a scan
# interrupted mid-page never leaves a truncated JPEG in the pipeline folder.
flush_stage() {
  shopt -s nullglob
  local files=("$STAGE"/raw-*.jpg)
  [ ${#files[@]} -eq 0 ] && return 0

  local idx date_prefix target moved=0
  idx="$(next_index)"
  date_prefix="$(date +%Y-%m-%d)"

  local f
  while IFS= read -r f; do
    target="$(printf '%s/%s-%04d.jpg' "$DEST" "$date_prefix" "$idx")"
    while [ -e "$target" ]; do
      idx=$((idx + 1))
      target="$(printf '%s/%s-%04d.jpg' "$DEST" "$date_prefix" "$idx")"
    done
    mv "$f" "$target"
    idx=$((idx + 1))
    moved=$((moved + 1))
  done < <(printf '%s\n' "${files[@]}" | sort)

  echo "[scan] saved $moved image(s) -> $(basename "$DEST")/"
}

on_exit() {
  trap - INT TERM EXIT
  echo
  flush_stage || true
  rm -rf "$STAGE"
  echo "[scan] stopped."
}
trap on_exit INT TERM EXIT

# ── Scan loop ─────────────────────────────────────────────────────────────────

waiting=0

while true; do
  rm -f "$STAGE"/raw-*.jpg

  set +e
  scanimage -d "$DEVICE" \
    --source "$SCAN_SOURCE" \
    --mode "$SCAN_MODE" \
    --resolution "$SCAN_RES" \
    --page-width "$SCAN_PAGE_W" --page-height "$SCAN_PAGE_H" \
    -x "$SCAN_PAGE_W" -y "$SCAN_PAGE_H" \
    --brightness "$SCAN_BRIGHTNESS" --contrast "$SCAN_CONTRAST" \
    --overscan "$SCAN_OVERSCAN" \
    --hwdeskewcrop="$SCAN_DESKEWCROP" \
    `# Card stock is thicker than paper, so the fi-7160's jam-prediction and` \
    `# ultrasonic double-feed sensors both false-trigger on every card.` \
    `# Without these four flags the scanner aborts with "Document feeder` \
    `# jammed" (omr-df=yes, error-code=49) before transferring any data --` \
    `# it is not a real jam, and correct page geometry alone does NOT fix it.` \
    --paper-protect Off --adv-paper-protect Off \
    --df-action Continue --df-recovery Off \
    `# Lets the ADF read ahead instead of stalling between pages.` \
    --buffermode On \
    --format=jpeg \
    --batch="$STAGE/raw-%04d.jpg" --batch-start=1 \
    > /dev/null 2> "$STAGE/err.log"
  set -e

  shopt -s nullglob
  scanned=("$STAGE"/raw-*.jpg)

  if [ ${#scanned[@]} -gt 0 ]; then
    echo "[scan] scanned ${#scanned[@]} image(s)"
    flush_stage
    waiting=0
    echo "[scan] load the next batch (Ctrl-C to stop)"
  elif grep -q "out of documents" "$STAGE/err.log" 2> /dev/null; then
    if [ "$waiting" -eq 0 ]; then
      echo "[scan] waiting for cards..."
      waiting=1
    fi
    sleep "$POLL_SECONDS"
  else
    echo "[scan] scanner error:" >&2
    grep -v '^$' "$STAGE/err.log" | grep -v 'rounded value' | head -5 >&2
    sleep "$POLL_SECONDS"
  fi
done
