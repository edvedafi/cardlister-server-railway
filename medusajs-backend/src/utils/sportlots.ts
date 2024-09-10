import process from 'node:process';
import { PuppeteerHelper } from './puppeteer-helper';

export async function login(pup: PuppeteerHelper) {
  await pup.goto('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
  await pup.locator('input[name="email_val"]').fill(process.env.SPORTLOTS_ID);
  await pup.locator('input[name="psswd"]').fill(process.env.SPORTLOTS_PASS);
  await pup.submit();
  await pup.waitForURL(/index.tpl/);
  return pup;
}
