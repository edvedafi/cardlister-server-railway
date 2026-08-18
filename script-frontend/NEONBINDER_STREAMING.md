# NeonBinder streaming intake (NEO-170)

When `NEONBINDER_CONVEX_URL` is set, `yarn start`'s watch mode stops cropping,
classifying, and pairing locally. Instead every scan dropped into the input
directory is uploaded straight to the NeonBinder pipeline (one signed-URL POST
per file), the server does crop + identity + front/back pairing, and matched
pairs stream back over a reactive subscription. The moment a pair lands, its
cropped images are downloaded and the normal review menu opens — while later
scans keep uploading behind it. Unset the variable and the legacy local
pipeline runs exactly as before.

## What changes at the terminal

- Per-file spinners: `Uploading` → `Queued remotely` → `Processing remotely` →
  a checkmark with the recognized identity (or a red line if the server failed
  that image). Processing takes ~40–80 s per card behind the scanner.
- The idle screen shows live session counts (uploaded / processing / pairs /
  failed) and which cards are still waiting for a partner. The pool-fix
  options (`p`/`r`/`x`) don't exist in this mode — pairing state lives on the
  server.
- `c` (Complete) closes the NeonBinder scan session, abandons anything
  unpaired (marked in `scanned.txt`, same as the legacy pool semantics), and
  proceeds to the normal sync. Ctrl-C also closes the session. If the process
  dies without closing, the server's 30-minute idle sweep finishes the job.
- Rejecting one side of a pair in the review menu can NOT return the kept side
  to matching (no server-side un-pair yet) — re-scan BOTH sides to create a
  fresh pair.

## Environment

Add to `script-frontend/.env` (names only here — never commit values):

| Variable | Required | What it is |
|---|---|---|
| `NEONBINDER_CONVEX_URL` | yes (enables the mode) | The Convex deployment URL, e.g. the PR preview deployment `https://<name>.convex.cloud` |
| `NEONBINDER_APP_URL` | yes | A NeonBinder web app origin that serves `/api/auth/testing` — the local vite dev server (`http://localhost:5173`, simplest) or a Vercel preview URL |
| `NEONBINDER_TESTING_SECRET` | yes | The app's `TESTING_ENDPOINT_SECRET` (copy from `neonbinder-mono/apps/web/.env.local`) |
| `NEONBINDER_CLERK_FAPI_URL` | yes | The Clerk dev instance Frontend API, `https://moved-kingfish-65.clerk.accounts.dev` |
| `NEONBINDER_TEST_ACCOUNT` | no (default `main`) | Which allowlisted test account to act as (`main`, `new-profile`, `admin-*`) |
| `NEONBINDER_VERCEL_BYPASS` | only for Vercel-preview `NEONBINDER_APP_URL` | `VERCEL_AUTOMATION_BYPASS_SECRET`, gets past deployment protection |
| `NEONBINDER_CLERK_SECRET_KEY` + `NEONBINDER_USER_EMAIL` | no | Alternative ticket source: mint directly from the Clerk Backend API and act as a real user instead of a test account |

The auth flow: fetch a single-use Clerk sign-in ticket (testing endpoint or
direct mint) → exchange it headlessly at the Clerk Frontend API
(`strategy=ticket`) → mint short-lived `convex`-template JWTs on demand for
the Convex client. Auth is dev/preview-only by design: the testing endpoint
hard-404s in production.

## Morning-test runbook

1. In the monorepo worktree, start the web dev server (`apps/web`,
   `npm run dev`) so `http://localhost:5173/api/auth/testing` is available —
   or use the PR's Vercel preview URL plus the bypass secret.
2. Fill the env vars above; point `NEONBINDER_CONVEX_URL` at the PR preview
   Convex deployment (it has the streaming functions; the shared dev
   deployment does not until the PR merges).
3. `yarn start`, pick the set as usual.
4. Drop scans into the input directory (front, back, front, back — scan order
   is the pairing's adjacency signal).
5. Review pairs as they pop; press `c` when done.

Known judgment calls (v1): a server-side pair *revision* after a card already
entered review is skipped with a warning (first pairing wins); crop-download
failures fall back to reviewing the raw local scan; upload failures leave the
file unmarked so the next run retries it.
