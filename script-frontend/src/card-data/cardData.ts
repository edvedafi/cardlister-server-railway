import type { Category, Metadata, SetInfo } from '../models/setInfo';
import { ask } from '../utils/ask';
import type { Prices, Product, ProductVariant } from '../models/cards';
import type { Card } from '../models/bsc';
import { isNo, isYes, psaGrades } from '../utils/data';
import {
  getInventory,
  getInventoryQuantity,
  getProductVariant,
  getRegion,
  updateInventory,
  updatePrices,
  updateProductImages,
  updateProductVariant,
} from '../utils/medusa';
import { useSpinners } from '../utils/spinners';
import type { InventoryItemDTO, MoneyAmount } from '@medusajs/client-types';

const { log } = useSpinners('card-data', chalk.whiteBright);

export async function buildProductFromBSCCard(card: Card, set: Category): Promise<Product> {
  const product: Partial<Product> = {
    type: 'Card',
    categories: [set],
    weight: 1,
    length: 4,
    width: 6,
    height: 1,
    origin_country: 'US',
    material: 'Card Stock',
  };
  // tags: need to get form BSC and asking
  product.metadata = {
    cardNumber: card.cardNo,
    player: card.players,
    teams: card.teamName || 'Unknown',
    sku: `${set.metadata.bin}|${card.cardNo}`,
    size: 'Standard',
    thickness: '20pt',
    bsc: card.id,
    printRun: card.printRun,
    autograph: card.autograph,
  };
  if (card.sportlots) {
    product.metadata.sportlots = card.sportlots;
  }
  const titles = await getTitles({ ...product, ...set.metadata, ...product.metadata });
  product.title = titles.title;
  product.description = titles.longTitle;
  product.metadata.cardName = await getCardName({ title: titles.title, metadata: product.metadata }, set);

  product.size = 'Standard';
  product.material = 'Card Stock';
  product.thickness = '20pt';
  product.lbs = 0;
  product.oz = 1;
  product.length = 6;
  product.width = 4;
  product.depth = 1;

  return product as Product;
}

const add = (info?: string, modifier?: string): string => {
  if (info === undefined || info === null || info === '' || isNo(info)) {
    return '';
  } else if (modifier) {
    return ` ${info} ${modifier}`;
  } else {
    return ` ${info}`;
  }
};

type Titles = {
  title: string;
  longTitle: string;
  cardName: string;
};

//try to get to the best 80 character title that we can
export async function getTitles(card: Metadata): Promise<Titles> {
  const maxTitleLength = 80;

  const titles: Partial<Titles> = {};

  let insert = add(card.insert, 'Insert');
  let parallel = add(card.parallel, 'Parallel');
  const features = add(card.features).replace(' | ', '');
  const printRun = card.printRun ? ` /${card.printRun}` : '';
  let setName = card.setName;
  const teamDisplay = card.teams;
  const graded = isYes(card.graded) ? ` ${card.grader} ${card.grade} ${psaGrades[card.grade]}` : '';

  titles.longTitle = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  let title = titles.longTitle;
  if (title.length > maxTitleLength && ['Panini', 'Leaf'].includes(card.brand)) {
    setName = card.setName;
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  }
  // if (title.length > maxTitleLength) {
  //   teamDisplay = card.team.map((team) => team.team).join(' | ');
  //   title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  // }
  // if (title.length > maxTitleLength) {
  //   teamDisplay = card.team.map((team) => team.team).join(' ');
  //   title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  // }
  if (title.length > maxTitleLength) {
    insert = add(card.insert);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    parallel = add(card.parallel);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player} ${teamDisplay}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${printRun}${graded}`;
  }

  title = title.replace(/ {2}/g, ' ');

  if (title.length > maxTitleLength) {
    title = await ask(`Title`, titles.longTitle, { maxLength: maxTitleLength });
  }
  titles.title = title;

  return titles as Titles;
}

type CardNameFields = {
  title: string;
  metadata: Metadata;
};

//generate a 60 character card name
async function getCardName(card: CardNameFields, category: Category): Promise<string> {
  if (!card.title) throw 'Must have Title to generate Card Name';

  const maxCardNameLength = 60;
  let cardName = card.title.replace(' | ', ' ');
  const insert = add(category.metadata.insert);
  const parallel = add(category.metadata.parallel);
  if (cardName.length > maxCardNameLength) {
    cardName =
      `${category.metadata.year} ${category.metadata.brand} ${category.metadata.setName}${insert}${parallel} ${card.metadata.player}`.replace(
        ' | ',
        ' ',
      );
  }
  if (cardName.length > maxCardNameLength) {
    cardName =
      `${category.metadata.year} ${category.metadata.setName}${insert}${parallel} ${card.metadata.player}`.replace(
        ' | ',
        ' ',
      );
  }
  if (cardName.length > maxCardNameLength) {
    cardName = `${category.metadata.year} ${category.metadata.setName}${insert}${parallel}`;
  }
  if (cardName.length > maxCardNameLength) {
    cardName = `${category.metadata.setName}${insert}${parallel}`;
  }
  cardName = cardName.replace(/ {2}/g, ' ').replace(' | ', ' ');

  if (cardName.length > maxCardNameLength) {
    cardName = await ask('Card Name', cardName, {
      maxLength: maxCardNameLength,
    });
  }

  return cardName;
}

export async function getCardData(setData: SetInfo, imageDefaults: Metadata) {
  if (!setData.products) throw 'Must Set Products on Set Data before getting card data';

  const product = await matchCard(setData, imageDefaults);
  let productVariantId;
  if (product.variants.length === 1) {
    productVariantId = product.variants[0].id;
  } else {
    productVariantId = await ask('Which variant is this?', undefined, {
      selectOptions: product.variants.map((variant) => ({
        name: `${variant.title}`,
        value: variant.id,
      })),
    });
  }
  const productVariant = await getProductVariant(productVariantId);

  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  productVariant.prices = await getPricing(productVariant.prices);

  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  const quantity = await ask('Quantity', (await getInventoryQuantity(productVariant)) || 1);

  return { productVariant, quantity };
}

async function getPricing(currentPrices: MoneyAmount[] = []): Promise<MoneyAmount[]> {
  if (currentPrices.length > 0 && (await ask('Use Current Pricing', true))) {
    return []; //currentPrices.map((price) => ({ amount: price.amount, region_id: price.region_id }) as MoneyAmount);
  } else {
    const isCommon = await ask('Use common card pricing', true);
    if (isCommon) {
      return await getBasePricing();
    } else {
      const ebayRegion = await getRegion('ebay');
      const mcpRegion = await getRegion('MCP');
      const bscRegion = await getRegion('BSC');
      const sportlotsRegion = await getRegion('SportLots');
      return [
        {
          amount: await ask('ebay price', currentPrices.find((price) => price.region_id === ebayRegion) || 99),
          region_id: ebayRegion,
        } as MoneyAmount,
        {
          amount: await ask('MCP Price', currentPrices.find((price) => price.region_id === mcpRegion) || 100),
          region_id: mcpRegion,
        } as MoneyAmount,
        {
          amount: await ask('BSC Price', currentPrices.find((price) => price.region_id === bscRegion) || 25),
          region_id: bscRegion,
        } as MoneyAmount,
        {
          amount: await ask(
            'SportLots Price',
            currentPrices.find((price) => price.region_id === sportlotsRegion) || 18,
          ),
          region_id: sportlotsRegion,
        } as MoneyAmount,
      ];
    }
  }
}

export async function matchCard(setInfo: SetInfo, imageDefaults: Metadata) {
  // log(products);
  let card = setInfo.products?.find(
    (product) =>
      product.metadata.cardNumber === `${setInfo.metadata.card_number_prefix}${imageDefaults.cardNumber}` &&
      product.metadata.player.includes(imageDefaults.player),
  );
  if (card) {
    return card;
  }
  card = setInfo.products?.find(
    (product) => product.metadata.cardNumber === `${setInfo.metadata.card_number_prefix}${imageDefaults.cardNumber}`,
  );
  if (card) {
    log(card.metadata);
    const isCard = await ask(`Is this the correct card?`, true);
    if (isCard) {
      return card;
    }
  }
  card = await ask('Which card is this?', undefined, {
    selectOptions: setInfo.products?.map((product) => ({
      name: `${product.metadata.cardNumber} ${product.metadata.player.join(', ')}`,
      value: product,
    })),
  });
  if (card) {
    return card;
  }
  throw new Error('No card found');
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

export async function saveListing(productVariant: ProductVariant, images: string[], quantity: string) {
  if (!productVariant.product) throw 'Must set Product on the Variant before saving listing';
  const listing = await getInventory(productVariant);
  await updateProductImages({
    id: productVariant.product.id,
    images: images,
  });
  await updateProductVariant(productVariant);
  await updateInventory(listing, quantity);
  return listing;
}

export async function saveBulk(
  product: Product,
  productVariant: ProductVariant,
  quantity: number,
): Promise<InventoryItemDTO> {
  const listing = await getInventory(productVariant);
  await updatePrices(product.id, productVariant.id, await getCommonPricing());
  // await updatePrices(product.id, productVariant.id, await getPricing());
  await updateInventory(listing, quantity);
  return listing;
}
