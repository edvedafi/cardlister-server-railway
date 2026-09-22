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
# Feed pacing. buffermode Off is deliberate and important.
#
# With buffermode On the scanner races ahead pulling cards into its internal
# memory. Those cards are physically through the transport before the host has
# taken delivery, so when a scan stalls they are stranded: fed, never captured,
# and indistinguishable afterwards from cards that were scanned fine. Observed
# 24 cards fed for 16 images. VueScan, which hangs on the same hardware fault,
# never loses a card -- it leaves them in the hopper -- which is what pointed at
# this setting.
#
# Losing cards silently is worse than stalling. Stalls are visible and the card
# is still in the hopper to retry; a swallowed card just quietly is not there.
SCAN_BUFFERMODE="${SCAN_BUFFERMODE:-Off}"       # Default|Off|On
SCAN_PREPICK="${SCAN_PREPICK:-Default}"         # Default|Off|On
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
# The fi-7160 intermittently stalls mid-transport: the paper stops moving and
# scanimage spins in sane_read forever waiting for bytes that never arrive (it
# burns CPU, so it looks alive). This is the same hang VueScan exhibits. There
# is no timeout in scanimage, so without a watchdog the loop waits forever.
# If no new page appears for this many seconds, kill the scan and retry.
# Measured healthy gaps: 0s front->back of a card, 2-3s card->card. 5s leaves
# margin over that while cutting the cost of a stall from 45s to 5s.
SCAN_STALL_SECONDS="${SCAN_STALL_SECONDS:-5}"
# The first page of a batch also covers feeding and lamp start, which is slower
# than the steady-state gap, so it gets its own grace period. Aborting a healthy
# page would leave a truncated JPEG that the listing pipeline ingests
# immediately, so this errs long.
SCAN_FIRST_PAGE_SECONDS="${SCAN_FIRST_PAGE_SECONDS:-25}"

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
  echo "[scan] settings: $SCAN_SOURCE, $SCAN_MODE, ${SCAN_RES}dpi, deskew+crop, buffer $SCAN_BUFFERMODE, prepick $SCAN_PREPICK"
fi
echo "[scan] Load cards in the feeder. Press Ctrl-C to stop."
echo

ERRLOG="$(mktemp)"
# Cards are assembled here and only moved to DEST once both sides are present,
# so the listing pipeline never sees a half-scanned card.
STAGE="$(mktemp -d)"

# ── Helpers ───────────────────────────────────────────────────────────────────

# Red, but only when stderr is a terminal, so redirected logs stay clean.
if [ -t 2 ]; then RED=$'\033[31m'; RESET=$'\033[0m'; else RED=""; RESET=""; fi

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

# Release finished CARDS from staging into DEST.
#
# scanimage writes a duplex card as two consecutive files, front then back, so a
# card is only usable as a pair. The listing pipeline ingests files the instant
# they appear in DEST, which means anything written there is committed -- it
# cannot be taken back by deleting it. So pairs are resolved here, in staging,
# and only complete cards are ever moved across.
#
# A staged file is known-complete once the NEXT one exists (scanimage writes
# sequentially), so while a scan is running the newest file is held back as
# possibly still being written. final=1 at end of batch, when all are complete.
#
# A leftover single at end of batch means that card scanned only one side. It is
# dropped, loudly, because a half-scanned card has to go back through the feeder
# anyway and a lone side would otherwise sit unmatched in the pairing pool.
MOVED=0
DROPPED=0
release_complete() {
  local final="${1:-0}"
  shopt -s nullglob
  local files=("$STAGE"/raw-*.jpg)
  local n=${#files[@]}
  [ "$n" -eq 0 ] && return 0

  local sorted=() f
  while IFS= read -r f; do sorted+=("$f"); done < <(printf '%s\n' "${files[@]}" | sort)

  local complete=$n
  if [ "$final" -eq 0 ]; then
    complete=$((n - 1))
  fi
  [ "$complete" -lt 0 ] && complete=0

  local pairs=$((complete / 2))
  local i idx target date_prefix
  if [ "$pairs" -gt 0 ]; then
    idx="$(next_index)"
    date_prefix="$(date +%Y-%m-%d)"
    for ((i = 0; i < pairs * 2; i++)); do
      target="$(printf '%s/%s-%04d.jpg' "$DEST" "$date_prefix" "$idx")"
      while [ -e "$target" ]; do
        idx=$((idx + 1))
        target="$(printf '%s/%s-%04d.jpg' "$DEST" "$date_prefix" "$idx")"
      done
      mv "${sorted[$i]}" "$target"
      echo "[scan] saved $(basename "$target")"
      idx=$((idx + 1))
      MOVED=$((MOVED + 1))
    done
  fi

  if [ "$final" -eq 1 ] && [ $((complete % 2)) -eq 1 ]; then
    rm -f "${sorted[$((complete - 1))]}"
    DROPPED=$((DROPPED + 1))
    printf '%s[scan] Deleting single image -- that card scanned only one side. Put it back in the stack.%s\n' "$RED" "$RESET" >&2
  fi
  return 0
}

on_exit() {
  trap - INT TERM EXIT
  rm -f "$ERRLOG"
  rm -rf "$STAGE"
  echo
  echo "[scan] stopped."
}
trap on_exit INT TERM EXIT

# ── Scan loop ─────────────────────────────────────────────────────────────────

waiting=0

while true; do
  rm -f "$STAGE"/raw-*.jpg
  MOVED=0
  DROPPED=0

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
    --buffermode "$SCAN_BUFFERMODE" --prepick "$SCAN_PREPICK" \
    --format=jpeg \
    --batch="$STAGE/raw-%04d.jpg" --batch-start=1 \
    > /dev/null 2> "$ERRLOG" &
  scan_pid=$!

  # Release completed cards as they finish, and watch for a stall. Each new page
  # resets the stall timer; if nothing appears for the timeout the scanner has
  # wedged, so kill the scan and let the loop retry rather than hanging forever.
  staged_seen=0
  stalled=0
  killed=0
  got_any=0
  while kill -0 "$scan_pid" 2> /dev/null; do
    cnt=$(find "$STAGE" -maxdepth 1 -name 'raw-*.jpg' 2> /dev/null | wc -l | tr -d ' ')
    if [ "$cnt" -gt "$staged_seen" ]; then
      staged_seen="$cnt"
      stalled=0
      got_any=1
      release_complete 0
    else
      # Before the first page lands, allow the longer feed/lamp-start grace.
      if [ "$got_any" -eq 1 ]; then
        limit="$SCAN_STALL_SECONDS"
      else
        limit="$SCAN_FIRST_PAGE_SECONDS"
      fi
      stalled=$((stalled + 1))
      if [ "$stalled" -ge "$limit" ]; then
        echo "[scan] no page for ${limit}s -- scanner stalled, aborting this batch" >&2
        # Escalate gently. scanimage traps SIGINT and calls sane_cancel/
        # sane_close, which releases the USB device properly. SIGTERM/SIGKILL
        # skip that teardown and leave the fi-7160 wedged -- libusb still sees
        # it but the backend cannot enumerate it, and it needs a power cycle.
        kill -INT "$scan_pid" 2> /dev/null
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          kill -0 "$scan_pid" 2> /dev/null || break
          sleep 1
        done
        if kill -0 "$scan_pid" 2> /dev/null; then
          echo "[scan] scan did not exit on SIGINT; forcing it" >&2
          echo "[scan] the scanner may need a power cycle before the next batch" >&2
          kill -TERM "$scan_pid" 2> /dev/null
          sleep 2
          kill -9 "$scan_pid" 2> /dev/null
        fi
        killed=1
        break
      fi
      sleep 1
    fi
  done
  wait "$scan_pid" 2> /dev/null
  set -e

  # Everything staged is complete now, so release the rest and drop any single.
  release_complete 1

  if [ "$killed" -eq 1 ]; then
    waiting=0
    echo "[scan] stalled batch aborted: $MOVED image(s) = $((MOVED / 2)) card(s) kept" >&2
    echo "[scan] cards are still in the feeder -- leave them to retry (Ctrl-C to stop)" >&2
    sleep "$POLL_SECONDS"
  elif [ "$MOVED" -gt 0 ] || [ "$DROPPED" -gt 0 ]; then
    waiting=0
    case "$SCAN_SOURCE" in
      *Duplex*) echo "[scan] batch done: $MOVED images = $((MOVED / 2)) cards" ;;
      *)        echo "[scan] batch done: $MOVED images." ;;
    esac
    echo "[scan] load the next batch (Ctrl-C to stop)"
  elif grep -q "out of documents" "$ERRLOG" 2> /dev/null; then
    if [ "$waiting" -eq 0 ]; then
      echo "[scan] waiting for cards..."
      waiting=1
    fi
    sleep "$POLL_SECONDS"
  else
    echo "[scan] scanner error:" >&2
    grep -v '^$' "$ERRLOG" | grep -v 'rounded value' | head -5 >&2
    sleep "$POLL_SECONDS"
  fi
done
