import { AxiosInstance } from 'axios';
import { PuppeteerHelper } from './puppeteer-helper';

export async function login(
  pup: PuppeteerHelper,
  axiosLogin: (url: string, headers: Record<string, string>) => AxiosInstance,
): Promise<AxiosInstance> {
  let token: string;
  try {
    const page = pup.page;
    await pup.home();

    await page.locator('button[tabindex="0"]').click();
    await pup.waitForURL('identity.buysportscards.com');
    await page.locator('#next').wait();

    await page.evaluate(
      (email, pass) => {
        // @ts-expect-error JS things
        document.getElementById('signInName').value = email;
        // @ts-expect-error JS things
        document.getElementById('password').value = pass;
        document.getElementById('next').click();
        // return window.location.href;
      },
      process.env.BSC_EMAIL,
      process.env.BSC_PASSWORD,
    );

    await pup.locatorText('p', 'Welcome back,').wait();

    token = await page.evaluate(function () {
      return JSON.parse(
        Object.values(localStorage)
          .filter((value) => value.includes('secret'))
          .find((value) => value.includes('Bearer')),
      ).secret.trim();
    });
  } catch (e) {
    console.error('Error logging in to BSC:', e);
    await pup.screenshot('login-error');
    throw e;
  }

  return axiosLogin('https://api-prod.buysportscards.com/', {
    assumedrole: 'sellers',
    authority: 'api-prod.buysportscards.com',
    authorization: `Bearer ${token}`,
  });
}
