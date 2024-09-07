import process from 'node:process';
import { PuppeteerHelper } from './puppeteer-helper';

export async function login(pup: PuppeteerHelper) {
  await pup.goto('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
  console.log('Logging in');
  await pup.locator('input[name="email_val"]').fill(process.env.SPORTLOTS_ID);
  console.log('entered email');
  await pup.locator('input[name="psswd"]').fill(process.env.SPORTLOTS_PASS);
  console.log('entered password');
  await pup.submit();
  console.log('clicked sign in');
  await pup.waitForURL(/index.tpl/);
  return pup;
}
