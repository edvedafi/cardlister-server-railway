/**
 * SportLots gates its login form behind Cloudflare Turnstile. Automated processes skip the
 * challenge by trading a per-account key/secret for a one-shot `authId`
 * (`POST /u/node/automated-access`), which is then sent on the sign-in POST as
 * `turnstile_auth_id`. Both requests must originate from the same IP, so the browser
 * implementation fetches it from inside the page and the forms implementation reuses its
 * axios client.
 */
export const SPORTLOTS_BASE_URL = 'https://www.sportlots.com/';
export const AUTOMATED_ACCESS_PATH = 'u/node/automated-access';
export const LOGIN_PAGE = 'cust/custbin/login.tpl?urlval=/index.tpl&qs=';
/** The login page's form posts to signin.tpl, not to itself. */
export const SIGNIN_ACTION = 'cust/custbin/signin.tpl';

export function getAutomatedAccessCredentials(): { keyId: string; secret: string } {
  const keyId = process.env.SPORTLOTS_KEY_ID;
  const secret = process.env.SPORTLOTS_SECRET;
  if (!keyId || !secret) {
    throw new Error('SPORTLOTS_KEY_ID and SPORTLOTS_SECRET must be set');
  }
  return { keyId, secret };
}

/** The raw body never carries our secret, but keep the error to the server's message anyway. */
export function parseAutomatedAccessResponse(data: unknown): string {
  const body = (typeof data === 'object' && data !== null ? data : {}) as {
    success?: unknown;
    authId?: unknown;
    message?: unknown;
  };
  if (body.success === true && typeof body.authId === 'string' && body.authId.trim()) {
    return body.authId.trim();
  }
  const reason = typeof body.message === 'string' && body.message ? body.message : 'no message';
  throw new Error(
    `SportLots automated-access request was rejected (${reason}) — check SPORTLOTS_KEY_ID/SPORTLOTS_SECRET`,
  );
}

/**
 * SportLots sets its session cookies from JavaScript in an onload handler rather than via
 * Set-Cookie headers, so a cookie jar sees nothing after a successful login. Pull the
 * assignments out of the response body so the caller can inject them into the jar.
 */
export function extractJsCookies(html: string): { name: string; value: string }[] {
  const cookies: { name: string; value: string }[] = [];
  const pattern = /document\.cookie\s*=\s*["']([^"'=;]+)=([^;"']*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html || '')) !== null) {
    const name = match[1].trim();
    if (name) {
      cookies.push({ name, value: match[2].trim() });
    }
  }
  return cookies;
}
