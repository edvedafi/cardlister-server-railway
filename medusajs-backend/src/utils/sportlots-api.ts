import { AxiosInstance } from 'axios';
import { CookieJar } from 'tough-cookie';
import {
  extractJsCookies,
  isLoginRedirectStub,
  parseOrdersResponse,
  parsePullSheet,
  SlOrderHeader,
  SlPullRow,
  SlStream,
  SportlotsAuthError,
  WarnFn,
} from './sportlots-parse';

export const SPORTLOTS_BASE_URL = 'https://www.sportlots.com/';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/**
 * Cookies are injected against the apex domain so they are sent to both sportlots.com and
 * www.sportlots.com — host-only cookies set on one would not survive a redirect to the other.
 */
const COOKIE_DOMAIN = 'sportlots.com';

const LOGIN_PAGE = 'cust/custbin/login.tpl?urlval=/index.tpl&qs=';
/** The login page's form posts to signin.tpl, not to itself. */
const SIGNIN_ACTION = 'cust/custbin/signin.tpl';

export type LoginAxios = (
  baseURL: string,
  headers: { [key: string]: string },
  useCookieJar?: boolean,
) => AxiosInstance;

const PULL_SHEET_TYPE: Record<SlStream, string> = { box: 'Box', paid: 'Buyer' };

function getJar(api: AxiosInstance): CookieJar {
  const jar = (api.defaults as { jar?: CookieJar }).jar;
  if (!jar) {
    throw new SportlotsAuthError('SportLots axios client was created without a cookie jar');
  }
  return jar;
}

async function harvestJsCookies(jar: CookieJar, html: string): Promise<string[]> {
  const cookies = extractJsCookies(html);
  for (const { name, value } of cookies) {
    await jar.setCookie(`${name}=${value}; Path=/; Domain=${COOKIE_DOMAIN}`, SPORTLOTS_BASE_URL);
  }
  return cookies.map((c) => c.name);
}

/**
 * Logs in over plain HTTP — no browser required.
 *
 * The wrinkle: a successful sign-in returns 200 with no Set-Cookie headers at all. The session
 * cookies are assigned from JavaScript in the response body's onload handler, so we scrape them out
 * and seed the jar ourselves.
 */
export async function login(loginAxios: LoginAxios): Promise<AxiosInstance> {
  const email = process.env.SPORTLOTS_ID;
  const password = process.env.SPORTLOTS_PASS;
  if (!email || !password) {
    throw new SportlotsAuthError('SPORTLOTS_ID and SPORTLOTS_PASS must be set');
  }

  const api = loginAxios(
    SPORTLOTS_BASE_URL,
    {
      'User-Agent': USER_AGENT,
      'Sec-Fetch-Site': 'same-origin',
    },
    true,
  );
  const jar = getJar(api);

  // Seed whatever the login page hands out (some cookies arrive via Set-Cookie, some via JS).
  const loginPage = await api.get(LOGIN_PAGE, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  await harvestJsCookies(jar, String(loginPage.data ?? ''));

  const form = new URLSearchParams({ urlval: '/index.tpl', email_val: email, psswd: password });
  const signIn = await api.post(SIGNIN_ACTION, form.toString(), {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: `${SPORTLOTS_BASE_URL}${LOGIN_PAGE}`,
    },
  });

  const harvested = await harvestJsCookies(jar, String(signIn.data ?? ''));
  if (!harvested.includes('session_reg')) {
    // Bad credentials just re-render the login page, so an empty harvest is the signal. Fail loudly
    // here: a silent failure downstream is indistinguishable from "no sales".
    throw new SportlotsAuthError(
      'SportLots sign-in did not return session cookies — check SPORTLOTS_ID/SPORTLOTS_PASS or a changed login form',
    );
  }

  const existing = await jar.getCookies(SPORTLOTS_BASE_URL);
  if (!existing.some((c) => c.key === 'xx')) {
    await jar.setCookie(`xx=Y; Path=/; Domain=${COOKIE_DOMAIN}`, SPORTLOTS_BASE_URL);
  }

  await assertSession(api);
  return api;
}

/**
 * Confirms the session is actually usable. Checking that the jar is non-empty is not enough — that
 * cannot tell a live session from an expired one, which is how a logged-out sync ends up silently
 * reporting zero orders.
 */
export async function assertSession(api: AxiosInstance): Promise<void> {
  const response = await api.get('s/node/orders/box', {
    headers: { accept: '*/*', referer: `${SPORTLOTS_BASE_URL}s/ui/box.html` },
    validateStatus: () => true,
  });
  if (response.status === 401 || (response.data as { success?: boolean })?.success !== true) {
    throw new SportlotsAuthError(
      `SportLots session is not valid (HTTP ${response.status}: ${
        (response.data as { message?: string })?.message || 'no message'
      })`,
    );
  }
}

export async function fetchOrderHeaders(
  api: AxiosInstance,
  stream: SlStream,
  onWarn?: WarnFn,
): Promise<SlOrderHeader[]> {
  const response = await api.get(`s/node/orders/${stream}`, {
    headers: {
      accept: '*/*',
      referer: `${SPORTLOTS_BASE_URL}s/ui/${stream}.html`,
    },
    // Never send conditional headers: a 304 hands back an empty body that would parse as zero
    // orders. Nothing sets them today, and this rejects the response if that ever changes.
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return parseOrdersResponse(response.data, stream, onWarn);
}

export async function fetchPullRows(api: AxiosInstance, stream: SlStream): Promise<SlPullRow[]> {
  const response = await api.get(`inven/dealbin/pullcards.tpl?OType=${PULL_SHEET_TYPE[stream]}`, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const html = String(response.data ?? '');
  if (isLoginRedirectStub(html)) {
    throw new SportlotsAuthError(`SportLots ${stream} pull sheet redirected to login`);
  }
  // The report carries onload="javascript:window.print()"; nothing executes it here.
  return parsePullSheet(html);
}
