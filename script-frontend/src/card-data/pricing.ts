import type { MoneyAmount } from '@medusajs/client-types';
import { ask } from '../utils/ask';
import { getRegion } from '../utils/medusa';
import { getBasePricing } from './cardData';
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
      return [];
    }
  } else {
    if (await ask('Use common card pricing', true)) {
      return await getBasePricing();
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
  return [
    await getPrice('ebay', 99),
    await getPrice('MCP', 100),
    await getPrice('BSC', 25),
    await getPrice('SportLots', 18),
  ];
}
