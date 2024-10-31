import type { MoneyAmount } from '@medusajs/client-types';
import { ask } from '../utils/ask';
import { getRegion } from '../utils/medusa';
import { useSpinners } from '../utils/spinners';

const { log } = useSpinners('Pricing', '#85BB65');

export async function getPricing(currentPrices: MoneyAmount[] = [], skipSafetyCheck = false): Promise<MoneyAmount[]> {
  const currentPrice = async (region: string): Promise<number | undefined> => {
    const regionId = await getRegion(region);
    const amount: number | string | undefined = currentPrices.find((price) => price.region_id === regionId)?.amount;
    // @ts-expect-error sometimes the backend returns a string for some crazy reason
    if (amount && amount !== 'undefined') {
      return amount;
    }
  };
  if (currentPrices && currentPrices.length > 1) {
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
        return currentPrices;
      }
    }
  } else {
    if (await ask('Use common card pricing', true)) {
      return await getBasePricing();
    } else {
      currentPrices = await getBasePricing();
    }
  }
  const prices: MoneyAmount[] = [];
  const getPrice = async (region: string, defaultPrice: number, minPrice: number): Promise<number> => {
    let startingPrice = (await currentPrice(region)) || defaultPrice;
    if (!startingPrice) {
      startingPrice = defaultPrice;
    }
    let price = await ask(`${region} price`, startingPrice);
    while (price.toString().indexOf('.') > -1) {
      price = await ask(`${region} price should not have a decimal, did you mean: `, price.toString().replace('.', ''));
    }
    while (price && parseInt(price) < minPrice) {
      price = await ask(`${region} price should not be less that the minimum, did you mean: `, `${price}00`);
    }
    if (price) {
      prices.push({
        amount: parseInt(price),
        region_id: await getRegion(region),
      } as MoneyAmount);
    } else {
      console.log(`Skipping Region: ${region}`);
    }
    return parseInt(price);
  };
  const ebay = await getPrice('ebay', 99, 99);
  await getPrice('MCP', ebay > 100 ? ebay : 100, 100);
  await getPrice('BSC', ebay, 25);
  await getPrice('SportLots', ebay, 18);
  if (ebay > 999) {
    await getPrice('MySlabs', ebay + 500, 999);
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
