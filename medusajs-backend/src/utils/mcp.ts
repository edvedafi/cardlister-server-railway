import { PuppeteerHelper } from './puppeteer-helper';

export async function login(pup: PuppeteerHelper): Promise<PuppeteerHelper> {
  await pup.goto(`login`, 'profile');

  if (pup.page.url().indexOf('login') > -1) {
    await pup.page.evaluate(
      (email, pass) => {
        (<HTMLInputElement>document.querySelector('input[type="email"]')).value = email;
        (<HTMLInputElement>document.querySelector('input[type="password"]')).value = pass;
        (<HTMLInputElement>(
          Array.from(document.querySelectorAll(`.yellow-btn`)).find((btn) => btn.textContent.trim() === 'Login')
        )).click();
      },
      process.env.MCP_EMAIL,
      process.env.MCP_PASSWORD,
    );

    await pup.locatorNotFound('.toast-message', 'Invalid Credentials: ');
    await pup.waitForURL('edvedafi');
  }
  await pup.goto('edvedafi?tab=shop');

  return pup;
}
