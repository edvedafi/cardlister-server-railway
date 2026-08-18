# NeonBinder streaming intake (NEO-170)

When `NEONBINDER_CONVEX_URL` is set, `yarn start`'s watch mode stops cropping,
classifying, and pairing locally. Instead every scan dropped into the input
directory is uploaded straight to the NeonBinder pipeline (one signed-URL POST
per file), the server does crop + identity + front/back pairing, and matched
pairs stream back over a reactive subscription. The moment a pair lands, its
cropped images are downloaded and the normal review menu opens — while later
scans keep uploading behind it. Unset the variable and the legacy local
pipeline runs exactly as before.

## Environment

Two variables (`script-frontend/.env` — never commit values):

| Variable | What it is |
|---|---|
| `NEONBINDER_CONVEX_URL` | The Convex deployment to stream into: production `https://first-starfish-800.convex.cloud`, or a PR's preview deployment URL for testing |
| `NEONBINDER_MACHINE_KEY` | Your NeonBinder API key (`ak_…` secret) — create it in the NeonBinder web app under **Settings → API Keys**, copy it once at creation |

(`NEONBINDER_CONVEX_SITE_URL` exists as an override for non-standard
deployments; normally derived automatically.)

## Auth model (NEO-172)

The API key is a per-client credential scoped to YOUR user: the client
exchanges it at the backend's `/machine/token` endpoint for short-lived
session tokens, so everything the script does is done as your account and
nothing more. Identical against preview, dev, and production. Revoke or
rotate the key any time from the same Settings → API Keys page — revocation
takes effect within about a minute. The key is shown once at creation, is
stored hashed server-side, and is never written to logs by this client.

If startup fails with:
- **401** — the key is wrong or revoked; create a fresh one in Settings → API Keys.
- **503** — that deployment's machine-token endpoint isn't configured
  (server-side `CLERK_SECRET_KEY` missing).

## What changes at the terminal

- Per-file spinners: `Uploading` → `Queued remotely` → `Processing remotely` →
  a checkmark with the recognized identity (or a red line if the server failed
  that image). Processing takes ~40–80 s per card behind the scanner.
- The idle screen shows live session counts (uploaded / processing / pairs /
  failed) and which cards are still waiting for a partner. The pool-fix
  options (`p`/`r`/`x`) don't exist in this mode — pairing state lives on the
  server.
- `a` (Abort) CANCELS remaining processing — queued and in-flight images stop
  (and stop billing); nothing is marked scanned, so an aborted batch re-runs
  cleanly next time. Use it when the wrong set/files went in.
- `c` (Complete) closes the NeonBinder scan session, abandons anything
  unpaired (marked in `scanned.txt`, same as the legacy pool semantics), and
  proceeds to the normal sync. Ctrl-C also closes the session. If the process
  dies without closing, the server's 30-minute idle sweep finishes the job.
- Rejecting one side of a pair in the review menu can NOT return the kept side
  to matching (no server-side un-pair yet) — re-scan BOTH sides to create a
  fresh pair.

## Runbook

1. Sign in to the NeonBinder app (the deployment you're targeting), go to
   **Settings → API Keys**, create a key (e.g. `cardlister-scanner`), copy it.
2. Set the two env vars above.
3. `yarn start`, pick the set as usual.
4. Drop scans into the input directory (front, back, front, back — scan order
   is the pairing's adjacency signal).
5. Review pairs as they pop; press `c` when done.

Known judgment calls (v1): a server-side pair *revision* after a card already
entered review is skipped with a warning (first pairing wins); crop-download
failures fall back to reviewing the raw local scan; upload failures leave the
file unmarked so the next run retries it.
