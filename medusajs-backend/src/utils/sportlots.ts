import process from 'node:process';
import { PuppeteerHelper } from './puppeteer-helper';
import { AUTOMATED_ACCESS_PATH, getAutomatedAccessCredentials } from './sportlots-automated-access';
import { parseAutomatedAccessResponse } from './sportlots-parse';

export async function login(pup: PuppeteerHelper) {
  await pup.goto('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
  await pup.locator('input[name="email_val"]').fill(process.env.SPORTLOTS_ID);
  await pup.locator('input[name="psswd"]').fill(process.env.SPORTLOTS_PASS);

  // The automated-access call has to come from the same IP as the sign-in POST, and the browser
  // (Browserless) does not necessarily share Railway's egress. Run it from inside the page so both
  // requests leave from wherever the browser lives. Credentials go across as evaluate arguments —
  // never interpolated into script source.
  const { keyId, secret } = getAutomatedAccessCredentials();
  const result = await pup.page.evaluate(
    async (path: string, keyId: string, secret: string) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, secret }),
      });
      return response.json();
    },
    `/${AUTOMATED_ACCESS_PATH}`,
    keyId,
    secret,
  );
  const authId = parseAutomatedAccessResponse(result);

  // form.submit() skips the page's submit listener, which would otherwise alert() about the
  // unsolved Turnstile widget and hang the browser. Clicking the button would trip it.
  await pup.page.evaluate((authId: string) => {
    (document.getElementById('turnstile_auth_id') as HTMLInputElement).value = authId;
    (document.getElementById('loginForm') as HTMLFormElement).submit();
  }, authId);
  await pup.waitForURL(/index.tpl/);
  return pup;
}
