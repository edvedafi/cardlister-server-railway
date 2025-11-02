import type { MoneyAmount } from '@medusajs/client-types';
import { ask } from '../utils/ask';
import { getRegion } from '../utils/medusa';
import { useSpinners } from '../utils/spinners';
import 'zx/globals';
import { isNo } from '../utils/data';
import { spawn } from 'child_process';

const { log } = useSpinners('Pricing', '#85BB65');

type CardSearchMetadata = {
  year?: string | number;
  setName?: string;
  insert?: string | string[];
  parallel?: string | string[];
  player?: string | string[];
  cardName?: string;
};

function formatMetadataField(value?: string | string[] | number): string {
  if (!value) return '';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.filter(v => v && !isNo(v)).join(' ');
  }
  return isNo(value) ? '' : value;
}

function buildSearchString(metadata?: CardSearchMetadata): string {
  if (!metadata) return '';
  
  const parts: string[] = [];
  
  if (metadata.year) {
    parts.push(String(metadata.year));
  }
  
  if (metadata.setName) {
    parts.push(metadata.setName);
  }
  
  const insert = formatMetadataField(metadata.insert);
  if (insert) {
    parts.push(insert);
  }
  
  const parallel = formatMetadataField(metadata.parallel);
  if (parallel) {
    parts.push(parallel);
  }
  
  const player = formatMetadataField(metadata.player);
  if (player) {
    parts.push(player);
  }
  
  return parts.join(' ').trim();
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    const platform = process.platform;
    
    if (platform === 'darwin') {
      // macOS - use pbcopy with stdin
      const proc = spawn('pbcopy', []);
      proc.stdin.write(text);
      proc.stdin.end();
      await new Promise<void>((resolve) => {
        proc.on('close', (code) => {
          if (code === 0) {
            log(`Copied search parameter to clipboard: "${text}"`);
          } else {
            console.warn('Clipboard copy failed with code:', code);
          }
          resolve();
        });
        proc.on('error', (error) => {
          console.warn('Failed to copy to clipboard:', error);
          resolve();
        });
      });
    } else if (platform === 'linux') {
      // Linux - try xclip first, then xsel
      try {
        const proc = spawn('xclip', ['-selection', 'clipboard']);
        proc.stdin.write(text);
        proc.stdin.end();
        await new Promise<void>((resolve) => {
          proc.on('close', (code) => {
            if (code === 0) {
              log(`Copied search parameter to clipboard: "${text}"`);
            } else {
              // Try xsel as fallback
              const xselProc = spawn('xsel', ['--clipboard', '--input']);
              xselProc.stdin.write(text);
              xselProc.stdin.end();
              xselProc.on('close', (xselCode) => {
                if (xselCode === 0) {
                  log(`Copied search parameter to clipboard (xsel): "${text}"`);
                } else {
                  console.warn('Both xclip and xsel failed');
                }
                resolve();
              });
              xselProc.on('error', () => {
                console.warn('Both xclip and xsel failed');
                resolve();
              });
            }
          });
          proc.on('error', () => {
            // Try xsel as fallback
            const xselProc = spawn('xsel', ['--clipboard', '--input']);
            xselProc.stdin.write(text);
            xselProc.stdin.end();
            xselProc.on('close', (xselCode) => {
              if (xselCode === 0) {
                log(`Copied search parameter to clipboard (xsel): "${text}"`);
              }
            });
            xselProc.on('error', () => {
              console.warn('Both xclip and xsel failed');
            });
          });
        });
      } catch (error) {
        console.warn('Failed to copy to clipboard:', error);
      }
    } else if (platform === 'win32') {
      // Windows - use clip.exe
      const proc = spawn('clip', []);
      proc.stdin.write(text);
      proc.stdin.end();
      await new Promise<void>((resolve) => {
        proc.on('close', (code) => {
          if (code === 0) {
            log(`Copied search parameter to clipboard: "${text}"`);
          } else {
            console.warn('Clipboard copy failed with code:', code);
          }
          resolve();
        });
        proc.on('error', (error) => {
          console.warn('Failed to copy to clipboard:', error);
          resolve();
        });
      });
    } else {
      console.warn('Unsupported platform for clipboard copy');
    }
  } catch (error) {
    // Silently fail if clipboard copy doesn't work
    console.warn('Failed to copy to clipboard:', error);
  }
}

export async function getPricing(
  currentPrices: MoneyAmount[] = [],
  skipSafetyCheck = false,
  allBase = false,
  cardMetadata?: CardSearchMetadata,
): Promise<MoneyAmount[]> {
  // Log which card we're pricing and copy search parameter to clipboard
  if (cardMetadata?.cardName) {
    log(`Pricing card: ${cardMetadata.cardName}`);
    const searchString = buildSearchString(cardMetadata);
    if (searchString) {
      await copyToClipboard(searchString);
    }
  } else if (cardMetadata) {
    // Fallback to building a card identifier from available metadata
    const identifier = buildSearchString(cardMetadata);
    if (identifier) {
      log(`Pricing card: ${identifier}`);
      await copyToClipboard(identifier);
    }
  }
  
  const basePrices = await getBasePricing();
  if (allBase) return basePrices;
  let startingPrices = [...currentPrices];

  const currentPrice = async (region: string): Promise<number | undefined> => {
    const regionId = await getRegion(region);
    let money = startingPrices.find((price) => price.region_id === regionId);
    if (!money) {
      money = basePrices.find((price) => price.region_id === regionId);
      if (money) {
        startingPrices.push(money);
      }
    }

    const amount: number | string | undefined = money?.amount;
    // @ts-expect-error sometimes the backend returns a string for some crazy reason
    if (amount && amount !== 'undefined') {
      return amount;
    }
  };
  if (startingPrices && startingPrices.length > 1) {
    if (!skipSafetyCheck) {
      log('Current Pricing:');
      const logPrice = async (region: string) => {
        log(`  ${region}: ${await currentPrice(region)}`);
      };
      await logPrice('ebay');
      await logPrice('MCP');
      await logPrice('BSC');
      await logPrice('SportLots');
      if (skipSafetyCheck || (await ask('Use Current Pricing', true))) {
        return startingPrices;
      }
    }
  } else {
    if (await ask('Use common card pricing', true)) {
      return await getBasePricing();
    } else {
      startingPrices = await getBasePricing();
    }
  }
  
  const prices: MoneyAmount[] = [];
  let manualEbayPrice: number | undefined = undefined;
  
  const getPrice = async (
    region: string,
    defaultPrice: number,
    minPrice: number,
    overrideDefault?: number
  ): Promise<{ price: number; wasManuallyChanged: boolean }> => {
    let startingPrice: number;
    
    // If override default is provided (e.g., from entered eBay price), use it
    if (overrideDefault !== undefined) {
      startingPrice = overrideDefault;
    } else {
      // Otherwise, use current price or fall back to default
      startingPrice = (await currentPrice(region)) || defaultPrice;
      if (!startingPrice) {
        startingPrice = defaultPrice;
      }
    }
    
    const originalStartingPrice = startingPrice;
    
    let price = await ask(`${region} price`, startingPrice);
    while (price.toString().indexOf('.') > -1) {
      price = await ask(`${region} price should not have a decimal, did you mean: `, price.toString().replace('.', ''));
    }
    while (price && parseInt(price) < minPrice) {
      price = await ask(`${region} price should not be less that the minimum, did you mean: `, `${price}00`);
    }
    if (price) {
      const parsedPrice = parseInt(price);
      const wasManuallyChanged = parsedPrice !== originalStartingPrice;
      
      prices.push({
        amount: parsedPrice,
        region_id: await getRegion(region),
      } as MoneyAmount);
      return { price: parsedPrice, wasManuallyChanged };
    } else {
      console.log(`Skipping Region: ${region}`);
      return { price: 0, wasManuallyChanged: false };
    }
  };
  
  // Get initial eBay price (preserves defaults: 99 for common cards)
  const ebayResult = await getPrice('ebay', 99, 99);
  const ebay = ebayResult.price;
  
  // If user manually entered a different value, use it for all subsequent prices
  if (ebayResult.wasManuallyChanged) {
    manualEbayPrice = ebay;
  }
  
  // Determine defaults for subsequent prices
  if (manualEbayPrice !== undefined) {
    // User manually changed eBay price, use that value for all remaining prices
    await getPrice('MCP', 100, 100, manualEbayPrice);
    await getPrice('BSC', ebay, 25, manualEbayPrice);
    await getPrice('SportLots', ebay, 18, manualEbayPrice);
    if (manualEbayPrice > 999) {
      await getPrice('MySlabs', ebay + 500, 999, manualEbayPrice + 500);
    }
  } else {
    // User accepted default, use original logic
    await getPrice('MCP', ebay > 100 ? ebay : 100, 100);
    await getPrice('BSC', ebay, 25);
    await getPrice('SportLots', ebay, 18);
    if (ebay > 999) {
      await getPrice('MySlabs', ebay + 500, 999);
    }
  }
  return prices;
}

let basePricing: MoneyAmount[];

export async function getBasePricing(): Promise<MoneyAmount[]> {
  if (!basePricing) {
    basePricing = [
      { amount: 99, region_id: await getRegion('ebay') } as MoneyAmount,
      { amount: 100, region_id: await getRegion('MCP') } as MoneyAmount,
      { amount: 25, region_id: await getRegion('BSC') } as MoneyAmount,
      { amount: 18, region_id: await getRegion('SportLots') } as MoneyAmount,
    ];
  }
  return basePricing;
}

let commonPricing: MoneyAmount[];

export async function getCommonPricing() {
  if (!commonPricing) {
    commonPricing = [
      { amount: 25, region_id: await getRegion('BSC') } as MoneyAmount,
      { amount: 18, region_id: await getRegion('SportLots') } as MoneyAmount,
    ];
  }
  return commonPricing;
}
