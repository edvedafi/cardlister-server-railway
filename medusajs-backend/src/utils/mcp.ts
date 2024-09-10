import { PuppeteerHelper } from './puppeteer-helper';

export async function login(pup: PuppeteerHelper): Promise<PuppeteerHelper> {
  await pup.goto(`login`);

  await pup.locator('input[type="email"]').fill(process.env.MCP_EMAIL);
  await pup.locator('input[type="password"]').fill(process.env.MCP_PASSWORD);
  await pup.screenshot('login');
  await (await pup.el({ locator: '.yellow-btn', text: 'Login' })).click();

  await pup.locatorNotFound('.toast-message', 'Invalid Credentials: ');

  await pup.goto('edvedafi?tab=shop');

  return pup;
}
