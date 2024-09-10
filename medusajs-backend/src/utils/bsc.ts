import { AxiosInstance } from 'axios';
import { PuppeteerHelper } from './puppeteer-helper';

export async function login(
  pup: PuppeteerHelper,
  axiosLogin: (url: string, headers: Record<string, string>) => AxiosInstance,
): Promise<AxiosInstance> {
  console.log('Logging in to BSC');
  const page = pup.page;
  await pup.home();

  console.log('At Home Page');

  await page.locator('button[tabindex="0"]').click();
  await page.waitForNavigation();

  await page.locator('#signInName').fill(process.env.BSC_EMAIL);
  await page.locator('#password').fill(process.env.BSC_PASSWORD);
  await page.locator('#next').click();

  await pup.locatorText('p', 'Welcome back,').wait();

  console.log('Logged in!');

  const token = await page.evaluate(function () {
    return JSON.parse(
      Object.values(localStorage)
        .filter((value) => value.includes('secret'))
        .find((value) => value.includes('Bearer')),
    ).secret.trim();
  });

  console.log('Token:', token);

  return axiosLogin('https://api-prod.buysportscards.com/', {
    assumedrole: 'sellers',
    authority: 'api-prod.buysportscards.com',
    authorization: `Bearer ${token}`,
  });
}
