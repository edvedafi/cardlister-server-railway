import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBrowserlessConfig(baseUrl: string, logKey: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    // Pin the chromedriver download cache to a stable dir. WebdriverIO defaults
    // this to os.tmpdir(), which macOS periodically purges — leaving an empty
    // version folder that breaks re-download ("executable is missing").
    cacheDir: path.join(os.homedir(), '.cache', 'webdriver'),
    capabilities: {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: [
          '--window-size=3000,2000',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService,NetworkServiceInProcess',
          '--force-color-profile=srgb',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--headless',
          '--no-sandbox',
        ],
      },
    },
    baseUrl: baseUrl,
  };
  if (process.env[logKey]) {
    config.logLevel = (process.env[logKey] as string).toLowerCase();
  }
  if (process.env.BROWSER_DOMAIN_PRIVATE) {
    config.path = '/webdriver';
    config.hostname = process.env.BROWSER_DOMAIN_PRIVATE;
    config.key = process.env.BROWSER_TOKEN;
    config.capabilities['browserless:token'] = process.env.BROWSER_TOKEN;
    if (process.env.BROWSER_PORT_PRIVATE === '443') {
      config.protocol = 'https';
      config.port = 443;
    } else if (process.env.BROWSER_PORT_PRIVATE) {
      config.port = parseInt(process.env.BROWSER_PORT_PRIVATE);
    }
  }
  return config;
}
