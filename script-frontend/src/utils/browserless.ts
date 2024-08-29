export function getBrowserlessConfig(baseUrl: string, logKey: string) {
  const config = {
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
    // @ts-expect-error Not really sure how to type this correctly
    config.logLevel = (process.env[logKey] as string).toLowerCase();
  }
  console.log('process.env.BROWSER_DOMAIN_PRIVATE', process.env.BROWSER_DOMAIN_PRIVATE);
  if (process.env.BROWSER_DOMAIN_PRIVATE) {
    config.path = '/webdriver';
    config.hostname = process.env.BROWSER_DOMAIN_PRIVATE;
    config.key = process.env.BROWSER_TOKEN;
    // @ts-expect-error Browserless token is a special key that is added but not part of the type definition
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
