import type { MoneyAmount } from '@medusajs/client-types';
import { ask } from '../utils/ask';
import { getRegion } from '../utils/medusa';
import { useSpinners } from '../utils/spinners';

const { log } = useSpinners('Pricing', '#85BB65');

export async function getPricing(currentPrices: MoneyAmount[] = []): Promise<MoneyAmount[]> {
  const currentPrice = async (region: string): Promise<number | undefined> => {
    const regionId = await getRegion(region);
    return currentPrices.find((price) => price.region_id === regionId)?.amount;
  };
  if (currentPrices && currentPrices.length > 1) {
    log('Current Pricing:');
    const logPrice = async (region: string) => {
      log(`  ${region}: ${await currentPrice(region)}`);
    };
    await logPrice('ebay');
    await logPrice('MCP');
    await logPrice('BSC');
    await logPrice('SportLots');
    if (await ask('Use Current Pricing', true)) {
      return currentPrices;
    }
  } else {
    if (await ask('Use common card pricing', true)) {
      return await getBasePricing();
    } else {
      currentPrices = await getBasePricing();
    }
  }
  const getPrice = async (region: string, defaultPrice: number): Promise<MoneyAmount> => {
    let price = await ask(`${region} price`, (await currentPrice(region)) || defaultPrice);
    while (price.toString().indexOf('.') > -1) {
      price = await ask(`${region} price should not have a decimal, did you mean: `, price.toString().replace('.', ''));
    }
    while (parseInt(price) < defaultPrice) {
      price = await ask(`${region} price should not be less that the minimum, did you mean: `, `${price}00`);
    }
    return {
      amount: parseInt(price),
      region_id: await getRegion(region),
    } as MoneyAmount;
  };
  const prices: MoneyAmount[] = [];
  const ebay = await getPrice('ebay', 99);
  prices.push(ebay);
  if (ebay.amount > 100) {
    prices.push(await getPrice('MCP', ebay.amount));
    prices.push(await getPrice('BSC', ebay.amount));
    prices.push(await getPrice('SportLots', ebay.amount));
    prices.push(await getPrice('MySlabs', ebay.amount + 500));
  } else {
    prices.push(await getPrice('MCP', 100));
    prices.push(await getPrice('BSC', 25));
    prices.push(await getPrice('SportLots', 18));
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
