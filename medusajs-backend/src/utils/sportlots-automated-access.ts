import { AxiosInstance } from 'axios';
import { parseAutomatedAccessResponse, SportlotsAuthError } from './sportlots-parse';

/**
 * SportLots gates its login form behind Cloudflare Turnstile. Automated processes skip the
 * challenge by trading a per-account key/secret for a one-shot `authId`, which is then sent on
 * the sign-in POST as `turnstile_auth_id`. Both requests must originate from the same IP.
 */
export const AUTOMATED_ACCESS_PATH = 'u/node/automated-access';

export function getAutomatedAccessCredentials(): { keyId: string; secret: string } {
  const keyId = process.env.SPORTLOTS_KEY_ID;
  const secret = process.env.SPORTLOTS_SECRET;
  if (!keyId || !secret) {
    throw new SportlotsAuthError('SPORTLOTS_KEY_ID and SPORTLOTS_SECRET must be set');
  }
  return { keyId, secret };
}

/**
 * Uses the caller's axios instance so the request shares an IP (and cookie jar) with the sign-in
 * POST that follows. The secret only ever travels in the HTTPS body — never a URL or a log line.
 */
export async function fetchAutomatedAuthId(api: AxiosInstance): Promise<string> {
  const response = await api.post(AUTOMATED_ACCESS_PATH, getAutomatedAccessCredentials(), {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    validateStatus: () => true,
  });
  return parseAutomatedAccessResponse(response.data);
}
