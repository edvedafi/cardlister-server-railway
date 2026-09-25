# SportLots

## Login

SportLots gates its sign-in form (`cust/custbin/login.tpl`) behind Cloudflare Turnstile. Scripted
sign-ins skip the challenge with an **Automated Access** credential issued per account by SportLots:

1. `POST https://www.sportlots.com/u/node/automated-access` with JSON `{ "keyId", "secret" }`
   → `{ "success": true, "authId": "…" }`. The `authId` is short-lived and single-use.
2. `POST cust/custbin/signin.tpl` (form-encoded) with `urlval`, `email_val`, `psswd` and
   `turnstile_auth_id=<authId>`.

Both requests **must come from the same IP**, and the account's normal email/password are still
required — the key/secret only authorises the automated login.

### Environment variables

| Variable | Purpose |
|---|---|
| `SPORTLOTS_ID` | account email |
| `SPORTLOTS_PASS` | account password |
| `SPORTLOTS_KEY_ID` | Automated Access key id |
| `SPORTLOTS_SECRET` | Automated Access secret — HTTPS body only; never in a URL, log line or the repo |

Set them in `script-frontend/.env` locally and in the Railway service variables for the backend.

### Implementations

| Where | File | Transport | Same-IP handling |
|---|---|---|---|
| backend sales sync | `medusajs-backend/src/utils/sportlots-api.ts` | axios + cookie jar | both POSTs use the same axios client |
| backend listing sync | `medusajs-backend/src/utils/sportlots.ts` | puppeteer (Browserless) | `automated-access` is fetched **inside the page** via `page.evaluate`, so it leaves from the browser's IP, not Railway's |
| script-frontend (default) | `script-frontend/src/listing-sites/sportlots.ts` | webdriverio | same in-page fetch via `browser.execute` |
| script-frontend `SL_IMPL=forms` | `script-frontend/src/listing-sites/sportlots-forms.ts` | axios + cookie jar | same axios client |

Shared pieces: `medusajs-backend/src/utils/sportlots-automated-access.ts` and
`script-frontend/src/listing-sites/sportlots-auth.ts`.

### Gotchas

- The login page's JS `submit` listener `alert()`s "Please complete the security verification" when
  the Turnstile widget is unsolved, which hangs a driven browser. The browser implementations set
  `#turnstile_auth_id` and call `form.submit()` directly — that does not fire the listener. Never
  click `#loginSubmit` from automation.
- A successful sign-in returns 200 with **no `Set-Cookie`**; the session cookies (`session_reg`,
  `session_type`, …) are assigned via `document.cookie` in the response body's `onload`. The scripted
  implementations scrape those with `extractJsCookies` and seed the jar themselves. `session_reg`
  missing from the harvest means the credentials (or the form) are wrong.
- The older hidden `login_check` field was removed in the Turnstile rollout. `extractLoginCheck`
  still forwards it if a page happens to render one, but its absence is not an error.
