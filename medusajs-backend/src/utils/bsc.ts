import { remote } from 'webdriverio';
import { getBrowserlessConfig } from './browserless';
import { AxiosInstance } from 'axios';

export async function login(
  axiosLogin: (url: string, headers: Record<string, string>) => AxiosInstance,
): Promise<AxiosInstance> {
  const browser = await remote(getBrowserlessConfig('https://www.buysportscards.com/', 'BSC_LOG_LEVEL'));

  let api: AxiosInstance;
  try {
    await browser.url('/');
    const signInButton = await browser.$('.=Sign In');
    await signInButton.waitForClickable({ timeout: 10000 });
    await signInButton.click();

    const emailInput = await browser.$('#signInName');
    await emailInput.waitForExist({ timeout: 5000 });
    await emailInput.setValue(process.env.BSC_EMAIL);
    await browser.$('#password').setValue(process.env.BSC_PASSWORD);

    await browser.$('#next').click();

    await browser.$('.=welcome back,').waitForExist({ timeout: 10000 });

    const reduxAsString: string = await browser.execute(
      'return Object.values(localStorage).filter((value) => value.includes("secret")).find(value=>value.includes("Bearer"));',
    );
    const redux = JSON.parse(reduxAsString);

    api = axiosLogin('https://api-prod.buysportscards.com/', {
      assumedrole: 'sellers',
      authority: 'api-prod.buysportscards.com',
      authorization: `Bearer ${redux.secret.trim()}`,
    });
  } finally {
    try {
      await browser?.deleteSession();
    } catch (e) {
      //TODO need to log this somewhere actionable, but don't want to throw an error
      this.log(`login::cleanup:: Failed to close browser session. Proceeding, but may cause leak! :: ${e.message}`);
    }
  }
  return api;
}
