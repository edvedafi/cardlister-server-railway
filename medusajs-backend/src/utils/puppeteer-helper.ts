import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer';
import { downloadFile } from './data';
import axios from 'axios';

export type ElementOrLocator =
  | string
  | ElementHandle
  | Promise<ElementHandle>
  | {
      locator: string | ElementHandle | Promise<ElementHandle>;
      text?: string;
      parent?: ElementHandle | Promise<ElementHandle>;
      findParent?: boolean;
    };

export class PuppeteerHelper {
  private baseUrl: string;
  page: Page;
  private logoutConnection: () => void;
  i = 0;

  async init(baseURL: string): Promise<Page> {
    let browser: Browser;
    if (process.env.BROWSERLESS_WS_ENDPOINT) {
      browser = await puppeteer.connect({
        // browserWSEndpoint: `${process.env.BROWSERLESS_WS_ENDPOINT}&--user-data-dir=/tmp/${extractDomain(baseURL)}`,
        browserWSEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
        defaultViewport: { height: 1080, width: 1920 },
      });
    } else {
      browser = await puppeteer.launch({ defaultViewport: { height: 1080, width: 1920 } });
    }
    this.page = await browser.newPage();
    this.baseUrl = baseURL;

    this.logoutConnection = () => {
      browser.disconnect();
      browser.close();
    };
    return this.page;
  }

  close() {
    if (this.logoutConnection) {
      this.logoutConnection();
    }
  }

  async screenshot(name?: string) {
    if (process.env.NODE_ENV === 'development') {
      await this.page.screenshot({ path: `debug/screenshot-${name ? `${name}-` : ''}${this.i++}.png` });
    }
  }

  async home() {
    await this.goto('');
  }

  async goto(url: string, redirectUrl?: string) {
    if (
      this.page.url() !== `${this.baseUrl}${url}` &&
      (!redirectUrl || this.page.url() !== `${this.baseUrl}${redirectUrl}`)
    ) {
      await this.page.goto(`${this.baseUrl}${url}`);
      try {
        await this.waitForURL(url, 10000, redirectUrl);
      } catch (e) {
        console.log(`Navigation failed to ${url}: ${e.message}`);
        await this.screenshot('navigation-failed');
        throw e;
      }
    }
  }

  locator(locator: string) {
    return this.page.locator(locator);
  }

  async $(selector: string) {
    return this.page.$(selector);
  }

  async $$(selector: string) {
    return this.page.$$(selector);
  }

  async select(selector: string, value: string | string[]) {
    if (Array.isArray(value)) {
      await this.page.select(selector, ...value);
    } else {
      await this.page.select(selector, value);
    }
  }

  async submit() {
    await this.locator('input[type="submit"]').click();
  }

  locatorText(locator: string, text: string) {
    return this.page.locator(`${locator} ::-p-text(${text})`);
  }

  async el(locator: ElementOrLocator): Promise<ElementHandle> {
    let element: ElementHandle;
    if (typeof locator === 'string') {
      element = await this.page.$(locator);
    } else if (locator instanceof Promise) {
      element = await locator;
    } else if ('parent' in locator) {
      if (typeof locator.locator === 'string') {
        if ('text' in locator && typeof locator.text === 'string') {
          element = await this.locatorText(locator.locator, locator.text).waitHandle();
        } else {
          element = await (await locator.parent).$(locator.locator);
        }
      } else if (
        'locator' in locator.locator &&
        typeof locator.locator.locator === 'string' &&
        'text' in locator.locator &&
        typeof locator.locator.text === 'string'
      ) {
        element = await (await locator.parent).$(`${locator.locator.locator} ::-p-text(${locator.locator.text})`);
      } else {
        element = await locator.locator;
      }
    } else if ('locator' in locator) {
      if ('text' in locator && typeof locator.text === 'string' && typeof locator.locator === 'string') {
        element = await this.locatorText(locator.locator, locator.text).waitHandle();
      }
    } else {
      element = locator;
    }

    if (typeof locator === 'object' && 'locator' in locator && locator.findParent && element) {
      element = await element.evaluateHandle((el) => el.parentElement);
    }
    return element;
  }

  async locatorNotFound(locator: string, errorText?: string) {
    let toast: ElementHandle;
    try {
      toast = await this.page.waitForSelector(locator, { visible: true, timeout: 1000 });
    } catch (e) {
      if (e.message?.toLowerCase().indexOf('waiting failed') === -1) {
        await this.screenshot(locator);
        throw new Error(`${errorText} ${e.message}`);
      }
    }
    if (toast && errorText) {
      const resultText = await toast.evaluate((el) => el.textContent);
      if (resultText.indexOf(errorText) > -1) {
        await this.screenshot(locator);
        throw new Error(`${errorText} ${resultText}`);
      }
    }
  }

  async locatorFound(locator: string, successText?: string, waitToDisappear?: boolean) {
    try {
      const toast = await this.page.waitForSelector(locator, { visible: true, timeout: 10000 });
      if (successText) {
        const text = await this.getText(toast);
        if (text.indexOf(successText) === -1) {
          await this.screenshot(locator);
          throw new Error(`Expected success text: ${successText}, but got: ${text}`);
        }
      }
    } catch (e) {
      await this.screenshot(locator);
      if (e.message?.toLowerCase().indexOf('waiting failed') === -1) {
        console.error(e);
      }
      throw new Error(`Element not found: ${locator}`);
    }
    if (waitToDisappear) {
      const dialog = await this.page.waitForSelector(locator, { hidden: true, timeout: 60000 });
      if (dialog) {
        await this.screenshot(locator);
        throw new Error(`${locator} ${successText} still displayed!`);
      }
    }
  }

  async getText(locator: ElementOrLocator) {
    const element = await this.el(locator);
    if (element) {
      const text = await element.evaluate((el) => el.textContent);
      if (text) {
        return text.replace('\n0', '').replace(/\n/, '').replace(/\s+/g, ' ').replace(/\n/, '').trim();
      }
    }
  }

  async getAttribute(locator: ElementOrLocator, attribute: string) {
    const element = await this.el(locator);
    if (element) {
      return element.evaluate((el, attribute) => el.getAttribute(attribute), attribute);
    } else {
      throw new Error(`Element not found: ${(await locator).toString()} trying to get attribute ${attribute}`);
    }
  }

  async getLink(locator: ElementOrLocator): Promise<{ text: string; href: string }> {
    const element = await this.el(locator);
    if (!element) throw new Error(`Element not found: ${(await locator).toString()}`);
    return {
      text: await this.getText(element),
      href: await this.getAttribute(element, 'href'),
    };
  }

  async hasText(locator: ElementOrLocator, text: string): Promise<boolean> {
    if (typeof locator === 'string' && locator === 'table') {
      return await this.page.$eval('table', () =>
        Array.from(document.querySelectorAll('td')).some((td) => td.textContent.includes(text)),
      );
    } else {
      return (await this.el(locator)).evaluate((el, text) => el.textContent.includes(text), text);
    }
  }

  async acceptAlert(validate?: string, timeout: number = 30000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (timeout) {
        setTimeout(() => reject('Alert not found'), timeout);
      }
      this.page.on('dialog', async (dialog) => {
        if (validate && !dialog.message().includes(validate)) {
          throw new Error(`Alert text validation failed. Expected: ${validate}, Actual: ${dialog.message()}`);
        }
        // Accept the alert
        await dialog.accept();
        resolve();
      });
    });
  }

  async waitForURL(urlMatch: string | RegExp, timeout: number = 5000, redirectUrl?: string): Promise<void> {
    try {
      if (typeof urlMatch === 'string') {
        if (redirectUrl) {
          await this.page.waitForFunction(
            (urlMatch: RegExp) => window.location.href.match(urlMatch),
            { timeout: timeout },
            new RegExp(`${urlMatch}|${redirectUrl}`),
          );
        } else {
          await this.page.waitForFunction(
            (urlMatch: string) => window.location.href.indexOf(urlMatch) > -1,
            { timeout: timeout },
            urlMatch,
          );
        }
      } else {
        await this.page.waitForFunction(
          (urlMatch: RegExp) => window.location.href.match(urlMatch),
          { timeout: timeout },
          urlMatch,
        );
      }
    } catch (e) {
      await this.screenshot('timeout-' + urlMatch.toString().replace(' ', '-').replace(/\//g, '-'));
      console.log(e);
      throw new Error(`Timeout waiting for URL: ${urlMatch}, but url is ${this.page.url()}`);
    }
  }

  async hasClass(locator: ElementOrLocator, className: string) {
    const element = await this.el(locator);
    return element.evaluate((el, className) => el.classList.contains(className), className);
  }

  async uploadImage(imageName: string, id: string): Promise<void> {
    const tmpFile = '/tmp/' + imageName;
    console.log(
      `Uploading: https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${imageName}?alt=media`,
    );
    try {
      await downloadFile(
        `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${imageName}?alt=media`,
        tmpFile,
      );
      console.log(`Downloaded: ${tmpFile}`);
      const inputUploadHandle = this.page.locator(`input[type="file"][name="${id}"]`);
      await (await inputUploadHandle.waitHandle()).uploadFile(tmpFile);
      await this.screenshot('upload-' + imageName);
    } catch (e) {
      await this.screenshot('upload-error');
      throw new Error(`Error uploading image ${imageName} to ${id}: ${e.message}`);
    } finally {
      // fs.removeSync(tmpFile);
    }
  }

  async fill(locator: ElementOrLocator, value: string) {
    const element = await this.el(locator);
    if (!element) throw new Error(`Element not found: ${(await locator).toString()}`);
    // @ts-expect-error input.value does actually exist. liar!63
    await element.evaluate((input, value) => (input.value = value), value);
  }

  async uploadImageBase64(imageName: string, id: string): Promise<void> {
    try {
      // Step 1: Download the image from the remote URL
      const response = await axios.get(
        `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${imageName}?alt=media`,
        { responseType: 'arraybuffer' },
      );

      // Step 2: Convert the response to a buffer
      const imageBuffer = Buffer.from(response.data, 'binary');

      const imageBase64 = imageBuffer.toString('base64');

      // Here, we assume you need to set this base64 string to an input field in your page
      // Modify the selector '#file-input' to the actual selector of your file input

      await this.page.evaluate(
        (imageBase64, imageName, id) => {
          const input = document.querySelector(`input[type="file"][name="${id}"]`); // Replace with the correct selector    // Decode base64 to binary
          function base64ToArrayBuffer(base64: string) {
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes.buffer;
          }

          // Create a new File object from the base64 data
          const byteArray = base64ToArrayBuffer(imageBase64);
          const file = new File([byteArray], imageName, { type: 'image/jpg' });

          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          // @ts-expect-error JS stuff
          input.files = dataTransfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        imageBase64,
        imageName,
        id,
      );
    } catch (e) {
      await this.screenshot('upload-error');
      throw new Error(`Error uploading image ${imageName} to ${id}: ${e.message}`);
    }
  }

  logNetworkRequests() {
    // this.page.on('response', async (response) => {
    //   if (response.url().indexOf('add-card') > -1) {
    //     console.log(response.statusText());
    //     console.log(await response.text());
    //   }
    // });
  }
}
