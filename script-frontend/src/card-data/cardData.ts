import type { Category, Metadata, SetInfo } from '../models/setInfo';
import { ask } from '../utils/ask';
import type { Card } from '../models/bsc';
import { isNo, isYes, psaGrades } from '../utils/data';
import {
  getInventory,
  getInventoryQuantity,
  getProductVariant,
  updateInventory,
  updatePrices,
  updateProductImages,
  updateProductVariant,
  updateProductVariantMetadata,
} from '../utils/medusa';
import { useSpinners } from '../utils/spinners';
import type { InventoryItemDTO, MoneyAmount, Product, ProductVariant } from '@medusajs/client-types';
import { getCommonPricing, getPricing } from './pricing';
import type { ParsedArgs } from 'minimist';
import _ from 'lodash';

const { log, showSpinner } = useSpinners('card-data', chalk.whiteBright);

export async function buildProductFromBSCCard(card: Card, set: Category): Promise<Product> {
  const product: Partial<Product> = {
    // @ts-expect-error Lies!
    type: 'card',
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
    sku: `${set.metadata?.bin}|${card.cardNo}`,
    size: 'Standard',
    thickness: '20pt',
    bsc: card.id,
    printRun: card.printRun || set.metadata?.printRun,
    autograph: set.metadata?.autograph || card.autograph,
    features: _.uniq(
      _.concat(
        [],
        card.features || [],
        set.metadata?.features || [],
        card.playerAttribute || [],
        card.playerAttributeDesc || [],
      ),
    ),
  };

  if (card.sportlots) {
    product.metadata.sportlots = card.sportlots;
  }
  const titles = await getTitles({ ...product, ...set.metadata, ...product.metadata });
  product.title = titles.title;
  product.description = titles.longTitle;
  product.metadata.cardName = await getCardName({ title: titles.title, metadata: product.metadata }, set);

  product.metadata.size = 'Standard';
  product.material = 'Card Stock';
  product.metadata.thickness = '20pt';
  product.metadata.lbs = 0;
  product.metadata.oz = 1;
  product.length = 6;
  product.width = 4;
  product.height = 1;

  if (
    set.metadata?.parallel &&
    !isNo(set.metadata?.parallel) &&
    !product.metadata.features.includes('Parallel/Variety')
  ) {
    product.metadata.features.push('Parallel/Variety');

    if (
      set.metadata?.parallel.toLowerCase().indexOf('refractor') > -1 &&
      !product.metadata.features.includes('Refractor')
    ) {
      product.metadata.features.push('Refractor');
    }
  }

  if (set.metadata?.insert && !isNo(set.metadata?.insert)) {
    product.metadata.features.push('Insert');
  }

  if (product.metadata.printRun && product.metadata.printRun > 0) {
    product.metadata.features.push('Serial Numbered');
  }

  if (product.metadata.features.includes('RC') && !product.metadata.features.includes('Rookie')) {
    product.metadata.features.push('Rookie');
  }

  if (product.metadata.features.length === 0) {
    product.metadata.features.push('Base Set');
  }

  const featureMap: { [key: string]: string } = {
    FBC: 'First Bowman',
    VAR: 'Variation',
  };
  product.metadata.features = _.uniq(
    product.metadata?.features.map((feature: string) => featureMap[feature] || feature) || [],
  )?.filter((feature) => feature);

  return product as Product;
}

const add = (info?: unknown, modifier?: string): string => {
  if (Array.isArray(info)) {
    if (info.length === 1) {
      info = ' ' + info[0];
    } else if (info.length === 0) {
      return '';
    } else if (info.length > 1) {
      info = ' ' + info.join(' | ');
    }
  }
  if (info === undefined || info === null || info === '' || isNo(<string>info)) {
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

  const features = add(
    card.features?.filter(
      (feature) =>
        !['Insert', 'Parallel/Variety', 'Serial Numbered', 'Base Set', 'Refractor', 'Rookie'].includes(feature),
    ),
  ).replace(' | ', ' ');
  const printRun = card.printRun ? ` /${card.printRun}` : '';
  const variation = add(card.variationName);
  let setName = card.setName;
  const teamDisplay = add(card.teams);
  const graded = isYes(<string>card.graded) ? ` ${card.grader} ${card.grade} ${psaGrades[<number>card.grade]}` : '';

  titles.longTitle = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  let title = titles.longTitle;
  if (title.length > maxTitleLength && ['Panini', 'Leaf'].includes(<string>card.brand)) {
    setName = card.setName;
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  }
  // if (title.length > maxTitleLength) {
  //   teamDisplay = card.team.map((team) => team.team).join(' | ');
  //   title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  // }
  // if (title.length > maxTitleLength) {
  //   teamDisplay = card.team.map((team) => team.team).join(' ');
  //   title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  // }
  if (title.length > maxTitleLength) {
    insert = add(card.insert);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    parallel = add(card.parallel);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${teamDisplay}${variation}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${features}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength) {
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${printRun}${graded}`;
  }
  // if (title.length > maxTitleLength && card.insert) {
  //   insert = add((<string>card.insert).replace(' Refractor', ''));
  //   title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${printRun}${graded}`;
  // }
  if (title.length > maxTitleLength && card.insert) {
    insert = add((<string>card.insert).replace('Rookie', 'RC'));
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength && card.parallel_xs) {
    parallel = add(<string>card.parallel_xs);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${printRun}${graded}`;
  }
  if (title.length > maxTitleLength && card.insert_xs) {
    insert = add(<string>card.insert_xs);
    title = `${card.year} ${setName}${insert}${parallel} #${card.cardNumber} ${card.player}${variation}${printRun}${graded}`;
  }

  title = title.replace(/ {2}/g, ' ');

  if (title.length > maxTitleLength) {
    title = await ask(`Title`, titles.longTitle, { maxLength: maxTitleLength });
  }
  titles.title = title.replace('  ', ' ');

  return titles as Titles;
}

type CardNameFields = {
  title: string;
  metadata: Metadata;
};

//generate a 60 character card name
async function getCardName(card: CardNameFields, category: Category): Promise<string> {
  if (!card.title) throw 'Must have Title to generate Card Name';
  if (!category.metadata) category.metadata = [];

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
  if (cardName.length > maxCardNameLength) {
    cardName = `${category.metadata.setName}${category.metadata.insert_xs || insert}${category.metadata.parallel_xs || parallel}`;
  }
  cardName = cardName.replace(/ {2}/g, ' ').replace(' | ', ' ');

  if (cardName.length > maxCardNameLength) {
    cardName = await ask('Card Name', cardName, {
      maxLength: maxCardNameLength,
    });
  }

  return cardName;
}

export async function getCardData(setData: SetInfo, imageDefaults: Metadata, args: ParsedArgs) {
  if (!setData.products) throw 'Must Set Products on Set Data before getting card data';

  const product = await matchCard(setData, imageDefaults);
  if (!product.variants) product.variants = [];

  let productVariantId;
  if (product.variants.length === 1) {
    productVariantId = product.variants[0].id;
  } else {
    productVariantId = await ask('Which variant is this?', undefined, {
      selectOptions: product.variants.map((variant) => ({
        name: `${variant.metadata?.description || variant.title}`,
        value: variant.id,
      })),
    });
  }
  const productVariant = await getProductVariant(productVariantId);

  const updatePVMetadata = (key: string) => {
    if (!product.metadata) product.metadata = {};
    if (!productVariant.metadata) productVariant.metadata = {};
    if (!productVariant.metadata[key] && product.metadata[key]) {
      productVariant.metadata[key] = product.metadata[key];
    }
    if (imageDefaults[key]) {
      if (!productVariant.metadata[key]) {
        if (Array.isArray(imageDefaults[key])) {
          productVariant.metadata[key] = imageDefaults[key];
        } else {
          productVariant.metadata[key] = (<object>imageDefaults[key]).toString().split('|');
        }
      } else if (Array.isArray(productVariant.metadata[key])) {
        if (Array.isArray(imageDefaults[key])) {
          productVariant.metadata[key] = productVariant.metadata[key].concat(imageDefaults[key]);
        } else {
          productVariant.metadata[key] = productVariant.metadata[key].concat(
            (<object>imageDefaults[key]).toString().split('|'),
          );
        }
      }
    }
  };
  updatePVMetadata('printRun');
  updatePVMetadata('autograph');
  updatePVMetadata('thickness');
  updatePVMetadata('features');
  if (!productVariant.metadata) productVariant.metadata = {};
  if (!productVariant.metadata.features) productVariant.metadata.features = [];
  if (
    setData.metadata?.parallel &&
    !isNo(setData.metadata?.parallel) &&
    !productVariant.metadata.features.includes('Parallel/Variety')
  ) {
    productVariant.metadata.features.push('Parallel/Variety');

    if (
      setData.metadata?.parallel.toLowerCase().indexOf('refractor') > -1 &&
      !productVariant.metadata.features.includes('Refractor')
    ) {
      productVariant.metadata.features.push('Refractor');
    }
  }

  if (setData.metadata?.insert && !isNo(setData.metadata?.insert)) {
    productVariant.metadata.features.push('Insert');
  }

  if (productVariant.metadata.printRun && productVariant.metadata.printRun > 0) {
    productVariant.metadata.features.push('Serial Numbered');
  }

  if (productVariant.metadata.features.includes('RC') && !productVariant.metadata.features.includes('Rookie')) {
    productVariant.metadata.features.push('Rookie');
  }

  if (productVariant.metadata.features.length === 0) {
    productVariant.metadata.features.push('Base Set');
  }

  productVariant.metadata.features = _.uniq(productVariant.metadata.features).filter((feature) => feature);

  log(productVariant.metadata);
  if (await ask('Update Card Details?', false)) {
    if (!productVariant.metadata) productVariant.metadata = {};

    let nextName: string | undefined;
    let i = 0;
    while (nextName || i === 0) {
      nextName = await ask('Player', productVariant.metadata?.player[i++]);
    }

    const printRun = await ask('Print Run', productVariant.metadata.printRun);
    if (printRun) {
      productVariant.metadata.printRun = printRun;
    }
    productVariant.metadata.autograph = await ask('Autograph', productVariant.metadata.autograph);
    productVariant.metadata.thickness = await ask('Thickness', productVariant.metadata.thickness);

    const featureResult = await ask('Features', productVariant.metadata.features);
    if (featureResult && featureResult.length > 0) {
      productVariant.metadata.features = featureResult;
    } else {
      productVariant.metadata.features = ['Base Set'];
    }
  }

  const prices = await getPricing(
    productVariant.prices && productVariant.prices.length > 1 //one is odd but there is always the default 99 cent price
      ? productVariant.prices
      : setData.category?.metadata?.prices,
    args['skipSafetyCheck'],
    args['allBase'],
  );
  if (productVariant.prices) {
    productVariant.prices = <MoneyAmount[]>prices
      .map((price: MoneyAmount): MoneyAmount | undefined => {
        const existingPrice = productVariant.prices?.find((p) => p.region_id === price.region_id);
        if (existingPrice) {
          return {
            id: existingPrice.id,
            amount: price.amount || existingPrice.amount,
            currency_code: existingPrice.currency_code,
            region_id: existingPrice.region_id,
          } as MoneyAmount;
        } else {
          return price;
        }
      })
      .filter((price) => price && price.amount);
  } else {
    productVariant.prices = prices;
  }

  const quantity = await ask('Quantity', (await getInventoryQuantity(productVariant)) || 1);

  return { productVariant, quantity };
}

export async function matchCard(setInfo: SetInfo, imageDefaults: Metadata) {
  // log(products);
  let card = setInfo.products?.find(
    (product) =>
      product.metadata?.cardNumber === `${setInfo.metadata?.card_number_prefix}${imageDefaults.cardNumber}` &&
      product.metadata.player.includes(imageDefaults.player),
  );
  if (card) {
    return card;
  }
  if (imageDefaults.player) {
    card = setInfo.products?.find(
      (product) =>
        product.metadata?.cardNumber === `${setInfo.metadata?.card_number_prefix}${imageDefaults.cardNumber}` &&
        product.metadata?.player.includes((<string>imageDefaults.player).replace(/[^a-zA-Z ]/g, '')),
    );
  }
  if (card) {
    return card;
  }
  card = setInfo.products?.find(
    (product) => product.metadata?.cardNumber === `${setInfo.metadata?.card_number_prefix}${imageDefaults.cardNumber}`,
  );
  if (card) {
    log(card.metadata);
    const isCard = await ask(`Is this the correct card?`, true);
    if (isCard) {
      return card;
    }
  }
  card = await ask('Which card is this?', imageDefaults.player, {
    selectOptions: setInfo.products?.map((product) => ({
      name: `${product.metadata?.cardNumber} ${product.metadata?.player.join(', ')}`,
      value: product,
    })),
  });
  if (card) {
    return card;
  }
  throw new Error('No card found');
}

export async function saveListing(productVariant: ProductVariant, images: string[], quantity: string) {
  if (!productVariant.product) throw 'Must set Product on the Variant before saving listing';
  const listing = await getInventory(productVariant);
  await updateProductImages({
    id: productVariant.product.id,
    images: images,
  });
  if (!productVariant.metadata) productVariant.metadata = {};
  productVariant.metadata.frontImage = images.shift();
  productVariant.metadata.backImage = images.shift();
  if (images.length > 0) {
    productVariant.metadata.extraImages = images;
  }
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
  if (quantity && listing.stocked_quantity != quantity) {
    if (!productVariant.prices || productVariant.prices.length === 1) {
      await updatePrices(product.id, productVariant.id, await getCommonPricing());
    }
    await updateInventory(listing, quantity);
  }
  return listing;
}

export async function setAllPricesToCommons(products: Product[] = []) {
  const prices = await getCommonPricing();
  for (const product of products) {
    if (product.variants) {
      for (const variant of product.variants) {
        await updatePrices(product.id, variant.id, prices);
      }
    }
  }
}

export async function cleanFeatures(products: Product[] = []) {
  for (const product of products) {
    if (product.variants) {
      for (const variant of product.variants) {
        if (!variant.metadata) variant.metadata = {};
        if (!variant.metadata.features) variant.metadata.features = [];
        let cleanFeatures: string[] = _.uniq(variant.metadata.features).filter((feature) => feature) as string[];
        if (!cleanFeatures) {
          cleanFeatures = ['Base Set'];
        } else if (cleanFeatures.length === 0) {
          cleanFeatures.push('Base Set');
        }

        if (cleanFeatures.length !== variant.metadata.features.length) {
          variant.metadata.features = cleanFeatures;
          variant.product = product;
          await updateProductVariantMetadata(variant.id, product.id, {
            ...variant.metadata,
            features: cleanFeatures,
          });
          console.log(variant.sku, ': Updated to ', cleanFeatures);
        }
      }
    }
  }
}
