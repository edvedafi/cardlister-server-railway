import chalk from 'chalk';
import { useSpinners } from '../utils/spinners.js';
import {
  type BSCFilterResponse,
  getBSCCards,
  getBSCSetFilter,
  getBSCSportFilter,
  getBSCVariantNameFilter,
  getBSCVariantTypeFilter,
  getBSCYearFilter,
} from '../listing-sites/bsc.js';
import { getSLBrand, getSLCards, getSLSet, getSLSport, getSLYear, shutdownSportLots } from '../listing-sites/sportlots-adapter';
import { ask, type AskOptions, type AskSelectOption } from '../utils/ask';
import type { Category, Metadata, SetInfo } from '../models/setInfo';
import {
  createCategory,
  createCategoryActive,
  createProduct,
  getCategories,
  getNextBin,
  getProductCardNumbers,
  getRootCategory,
  setCategoryActive,
  updateCategory,
  type Variation,
} from '../utils/medusa.js';
import Queue from 'queue';
import { type Card } from '../models/bsc';
import { type SLCard } from '../models/cards';
import { buildProductFromBSCCard, getTitles } from './cardData';
import { getPricing } from './pricing';
import type { MoneyAmount } from '@medusajs/client-types';
import _ from 'lodash';

const { showSpinner, log } = useSpinners('setData', chalk.whiteBright);

export async function findSet(
  {
    allowParent,
    onlySportlots,
    parentName,
  }: {
    allowParent?: boolean;
    onlySportlots?: boolean;
    parentName?: string;
  } = {
    allowParent: false,
    onlySportlots: false,
  },
): Promise<SetInfo> {
  const { update, finish, error } = showSpinner('findSet', 'Finding Set');
  const setInfo: Partial<SetInfo> = { handle: '', metadata: {} };

  const askNew = async (display: string, options: AskSelectOption[]) => {
    const selectOptions = options.sort((a, b) => a.name.localeCompare(b.name));
    selectOptions.push({ value: 'New', name: 'New' });
    if (allowParent) {
      selectOptions.push({ value: 'Parent', name: parentName || 'Parent' });
    }
    const response = await ask(display, undefined, { selectOptions: selectOptions });
    if (response === 'New') {
      return null;
    } else if (response === 'Parent') {
      finish();
    }
    return response;
  };

  try {
    update('Sport');
    const root = await getRootCategory();
    const sportCategories = await getCategoriesAsOptions(root);
    if (sportCategories.length > 0) {
      setInfo.sport = await askNew('Sport', sportCategories);
    }
    if (setInfo.sport) {
      setInfo.handle = setInfo.sport.handle;
    }
    while (!setInfo.sport) {
      update('New Sport');
      const sportlots = await getSLSport();
      setInfo.handle = sportlots.name;
      setInfo.sport = await createCategory(sportlots.name, root, setInfo.handle, {
        sportlots: sportlots.key,
      });
    }
    if (!setInfo.sport.metadata?.sportlots) {
      update('Add SportLots to Sport');
      const slSport = await getSLSport(setInfo.sport.name);
      if (slSport.key !== 'N/A') {
        setInfo.sport = await updateCategory(setInfo.sport.id, { ...setInfo.sport.metadata, sportlots: slSport.key });
      }
    }
    if (!setInfo.sport) throw new Error('Sport not found');
    if (!setInfo.sport?.metadata?.bsc) {
      update('Add BSC to Sport');
      const bscSport = await getBSCSportFilter(setInfo.sport.name);
      setInfo.sport = await updateCategory(setInfo.sport?.id, {
        ...setInfo.sport?.metadata,
        bsc: bscSport?.filter,
      });
    }
    if (!setInfo.sport) throw new Error('Sport not found');

    update('Year');
    const years = await getCategoriesAsOptions(setInfo.sport.id);
    let year: Category | string | undefined;
    if (years.length > 0) {
      year = await askNew('Year', years);
    }
    if (year) {
      if (year === 'Parent') {
        setInfo.category = setInfo.sport;
        return setInfo as SetInfo;
      } else {
        setInfo.year = year as Category;
        setInfo.handle = setInfo.year.handle;
      }
    }
    while (!setInfo.year) {
      update('New Year');
      const newYear = await ask('New Year');
      setInfo.handle = `${setInfo.sport.handle}-${newYear}`;
      setInfo.year = await createCategory(newYear, setInfo.sport.id, setInfo.handle, {
        sportlots: (await getSLYear(newYear)).key,
        bsc: getBSCYearFilter(newYear),
      });
    }

    update('Brand');
    const brandCategories = await getCategoriesAsOptions(setInfo.year.id);
    let brand: Category | string | undefined;
    if (brandCategories.length > 0) {
      brand = await askNew('brand', brandCategories);
    }
    if (brand) {
      if (brand === 'Parent') {
        setInfo.category = setInfo.year;
        return setInfo as SetInfo;
      } else {
        setInfo.brand = brand as Category;
        setInfo.handle = setInfo.brand.handle;
      }
    }
    while (!setInfo.brand) {
      update('New brand');
      const slBrand = await getSLBrand();
      setInfo.handle = `${setInfo.year?.handle}-${slBrand.name}`;
      setInfo.brand = await createCategory(slBrand.name, setInfo.year?.id, setInfo.handle, { sportlots: slBrand.key });
    }

    if (!setInfo.brand.metadata?.sportlots) {
      update('Add SportLots to brand');
      const slBrand = await getSLBrand(setInfo.brand.name);
      const updatedBrand: Category = await updateCategory(setInfo.brand.id, {
        ...setInfo.brand.metadata,
        sportlots: slBrand.key,
      });
      if (updatedBrand) {
        setInfo.brand = updatedBrand;
      }
    }

    update('Set');
    const setCategories = await getCategoriesAsOptions(setInfo.brand.id);
    let set: Category | string | undefined;
    if (setCategories.length > 0) {
      set = await askNew('Set', setCategories);
    }
    if (set) {
      if (set === 'Parent') {
        setInfo.category = setInfo.brand;
        return setInfo as SetInfo;
      } else {
        setInfo.set = set as Category;
        setInfo.handle = setInfo.set.handle;
      }
    }
    while (!setInfo.set) {
      update('New Set');
      const bscSet: { name: string; filter: unknown } = await getBSCSetFilter(setInfo);
      let setName: string;
      if (onlySportlots) {
        setName = await ask('Series 2 Title', bscSet.name);
      } else {
        setName = bscSet.name;
      }
      setInfo.handle = `${setInfo.brand.handle}-${setName}`;
      setInfo.set = await createCategory(setName, setInfo.brand.id, setInfo.handle, { bsc: bscSet.filter });
    }

    update('Variant Type');
    const variantTypeCategories = await getCategoriesAsOptions(setInfo.set.id);
    let variantType: Category | string | undefined;
    if (variantTypeCategories.length > 0) {
      variantType = await askNew('Variant Type', variantTypeCategories);
    }
    if (variantType) {
      if (variantType === 'Parent') {
        setInfo.category = setInfo.set;
        return setInfo as SetInfo;
      } else {
        setInfo.variantType = variantType as Category;
        setInfo.handle = setInfo.variantType.handle;
      }
    } else {
      update('New Variant Type');
      const bscVariantType: BSCFilterResponse = await getBSCVariantTypeFilter(setInfo);
      setInfo.handle = `${setInfo.set.handle}-${bscVariantType.name}`;
      if (bscVariantType.name === 'Base') {
        setInfo.handle = `${setInfo.set.handle}-${bscVariantType.name}-base`;
        const description = await ask('Set Title', `${setInfo.year.name} ${setInfo.set.name}`);
        const metadata: Metadata = {
          bsc: bscVariantType.filter,
          sportlots: await getSLSet(setInfo as SetInfo),
          bin: await getNextBin(),
          // bin: (
          //   await getGroup({
          //     sport: setInfo.sport?.name,
          //     manufacture: setInfo.brand.name,
          //     year: setInfo.year.name,
          //     setName: setInfo.set.name,
          //   })
          // ).bin,
          isInsert: false,
          isParallel: false,
          sport: setInfo.sport?.name,
          brand: setInfo.brand.name,
          year: setInfo.year.name,
          setName: setInfo.set.name,
          ...(await updateSetDefaults()),
        };

        setInfo.variantType = await createCategoryActive(
          bscVariantType.name,
          description,
          setInfo.set.id,
          setInfo.handle,
          metadata,
        );
      } else {
        setInfo.variantType = await createCategory(bscVariantType.name, setInfo.set.id, setInfo.handle, {
          bsc: bscVariantType.filter,
        });
      }
    }

    if (setInfo.variantType && !setInfo.variantType?.handle.endsWith('-base')) {
      update('Variant Name');
      const variantNameCategories = await getCategoriesAsOptions(setInfo.variantType?.id);
      let variantName: Category | string | undefined;
      if (variantNameCategories.length > 0) {
        variantName = await askNew('Variant Name', variantNameCategories);
      }
      if (variantName) {
        if (variantName === 'Parent') {
          setInfo.category = setInfo.variantType;
          return setInfo as SetInfo;
        } else {
          setInfo.variantName = variantName as Category;
          setInfo.handle = setInfo.variantName.handle;
        }
      } else {
        update('New Variant Name');
        const isInsert = setInfo.variantType?.name === 'Insert';
        let isParallel = setInfo.variantType?.name === 'Parallel';
        let insertName: string | undefined = undefined;
        let parallelName: string | undefined = undefined;

        const bscVariantName: BSCFilterResponse = await getBSCVariantNameFilter(setInfo);
        if (isInsert && !isParallel) {
          isParallel = await ask('Is this a parallel of an insert?', false);
        }
        if (isInsert && !isParallel) {
          insertName = bscVariantName.name;
        } else if (isInsert && isParallel) {
          const refractor = bscVariantName.name.indexOf('Refractor');
          if (refractor > -1) {
            insertName = bscVariantName.name.slice(0, refractor).trim();
            parallelName = bscVariantName.name.slice(refractor).trim();
          }
          insertName = bscVariantName.name.substring(0, bscVariantName.name.lastIndexOf(' ')).trim();
          insertName = await ask('Insert Name', insertName);
          if (insertName) {
            parallelName = bscVariantName.name.replace(insertName, '').trim();
            parallelName = await ask('Parallel Name', parallelName);
          }
        } else {
          parallelName = bscVariantName.name;
        }

        let variantName: string;
        if (onlySportlots) {
          variantName = await ask('Series 2 Variant Name', bscVariantName.name);
        } else {
          variantName = bscVariantName.name;
        }

        setInfo.handle = `${setInfo.variantType.handle}-${variantName}`;
        const metaData: Metadata = {
          bsc: bscVariantName.filter,
          isInsert,
          isParallel,
          bin: await getNextBin(),
          sport: setInfo.sport?.name,
          brand: setInfo.brand.name,
          year: setInfo.year.name,
          setName: setInfo.set.name,
          insert: insertName,
          parallel: parallelName,
          ...(await updateSetDefaults()),
        };

        setInfo.variantName = await createCategory(variantName, setInfo.variantType.id, setInfo.handle, metaData);
      }
      if (!setInfo.variantName) throw new Error('Variant Name not found');
      const updates: Metadata = {};
      if (!setInfo.variantName?.metadata?.sportlots) {
        const updateset = await getSLSet(setInfo as SetInfo);
        if (updateset) {
          updates.sportlots = updateset;
        }
      }
      let description;
      if (!setInfo.variantName?.description) {
        description = await ask('Set Title', `${setInfo.year.name} ${setInfo.set.name} ${setInfo.variantName?.name}`);
      }
      if (!setInfo.variantName?.metadata?.xs_setName) {
        updates.xs_setName = await ask('XS Set Name?', `${setInfo.set.name} ${setInfo.variantName?.name}`);
      }
      if (setInfo.variantName?.metadata?.insert && !setInfo.variantName?.metadata?.insert_xs) {
        updates.insert_xs = await ask('XS Insert Name?', setInfo.variantName?.metadata?.insert);
      }
      if (setInfo.variantName?.metadata?.parallel && !setInfo.variantName?.metadata?.parallel_xs) {
        updates.parallel_xs = await ask('XS Parallel Name?', setInfo.variantName?.metadata?.parallel);
      }
      if (Object.keys(updates).length > 0 || description || !setInfo.variantName?.is_active) {
        setInfo.variantName = await setCategoryActive(setInfo.variantName.id, description, {
          ...setInfo.variantName.metadata,
          ...updates,
        });
      }
    }

    setInfo.category = setInfo.variantName || setInfo.variantType;
    setInfo.metadata = setInfo.category?.metadata;

    finish();
    //Everything should be populated now, return it
    return setInfo as SetInfo;
  } catch (e) {
    error(e);
    throw e;
  }
}

export async function updateSetDefaults(metadata: Metadata = {}): Promise<Metadata> {
  const { finish, error } = showSpinner('updateSetDefaults', 'Updating Set Defaults');

  try {
    const update = async (field: string, config?: AskOptions) => {
      const response = await ask(field, metadata[field], config);
      if (response) {
        metadata[field] = response;
      }
    };

    await update('card_number_prefix');
    await update('features', { isArray: true });
    await update('printRun');
    await update('autograph', { selectOptions: ['None', 'Label or Sticker', 'On Card'] });

    metadata.prices = await getPricing(<MoneyAmount[]>metadata.prices);

    finish();
  } catch (e) {
    error(e);
  }
  return metadata;
}

export async function updateAllSetMetadata(
  category: Category,
  metadata: Metadata = {},
): Promise<{ description?: string; metadata: Metadata }> {
  const { finish, error } = showSpinner('updateAllSetMetadata', 'Updating All Set Metadata');

  try {
    // Start with existing metadata to preserve all fields
    const updatedMetadata = { ...metadata };

    const update = async (field: string, config?: AskOptions) => {
      const response = await ask(field, updatedMetadata[field], config);
      if (response !== undefined && response !== null && response !== '') {
        updatedMetadata[field] = response;
      }
    };

    // Update default metadata fields
    await update('card_number_prefix');
    await update('features', { isArray: true });
    await update('printRun');
    await update('autograph', { selectOptions: ['None', 'Label or Sticker', 'On Card'] });
    updatedMetadata.prices = await getPricing(<MoneyAmount[]>updatedMetadata.prices);

    // Update XS fields
    await update('xs_setName');
    if (updatedMetadata.insert) {
      await update('insert_xs');
    }
    if (updatedMetadata.parallel) {
      await update('parallel_xs');
    }

    // Get description (Set Title)
    let description: string | undefined;
    const currentDescription = category.description || '';
    if (currentDescription) {
      description = await ask('Set Title', currentDescription);
    } else {
      // Try to construct a default from category metadata
      const defaultTitle = category.metadata?.year && category.metadata?.setName
        ? `${category.metadata.year} ${category.metadata.setName}${category.name !== 'Base' ? ` ${category.name}` : ''}`
        : category.name;
      description = await ask('Set Title', defaultTitle);
    }

    finish();
    return { description, metadata: updatedMetadata };
  } catch (e) {
    error(e);
    throw e;
  }
}

export async function getCategoriesAsOptions(parent_category_id: string) {
  const categories = await getCategories(parent_category_id);
  return categories.map((category: Category) => ({
    value: category,
    name: category.name,
  }));
}

async function getSLCardsWithRetry(
  setInfo: SetInfo & { year: Category; brand: Category; sport: Category },
  category: Category,
  expectedCards: number,
  maxRetries = 3,
): Promise<{ cardNumber: string; title: string }[]> {
  let lastError: Error | unknown;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`Attempting to get SportLots cards (attempt ${attempt}/${maxRetries})`);
      return await getSLCards(setInfo, category, expectedCards);
    } catch (e) {
      lastError = e;
      log(`Error getting SportLots cards on attempt ${attempt}: ${e}`);
      
      if (attempt < maxRetries) {
        log(`Shutting down browser and retrying...`);
        try {
          await shutdownSportLots();
          // Wait a moment for the browser to fully close
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (shutdownError) {
          log(`Error during shutdown: ${shutdownError}`);
        }
      }
    }
  }
  
  // If we get here, all retries failed
  log(`Failed to get SportLots cards after ${maxRetries} attempts`);
  throw lastError;
}

export async function buildSet(setInfo: SetInfo) {
  const { update, finish, error } = showSpinner('buildSet', 'Building Set');
  try {
    update('Building Set');
    const category: Category = setInfo.variantName || setInfo.variantType;
    let bscCards = await getBSCCards(category);
    let builtProducts = 0;
    let cards: SiteCards;
    if (category.metadata?.sportlots) {
      const slCards = await getSLCardsWithRetry(setInfo, category, bscCards.length);
      cards = findVariations(bscCards, slCards);

      while (
        cards.slBase.length < cards.bscBase.length &&
        (await ask(`Is there another series? (${cards.slBase.length} in SL ${cards.bscBase.length} in BSC)`, true))
      ) {
        update('Looking for Series 2');
        const nextSeries = await findSet({ onlySportlots: true });
        // Use a reasonable default for expected cards since we don't know the exact count yet
        const nextSLCards = await getSLCardsWithRetry(nextSeries, nextSeries.category, bscCards.length - cards.slBase.length);
        const maxCardNumberString = _.maxBy(nextSLCards, 'cardNumber')?.cardNumber;
        const minCardNumberString = _.minBy(nextSLCards, 'cardNumber')?.cardNumber;
        const maxCardNumber = parseInt(maxCardNumberString?.replace(/\D/g, '') || '0');
        const minCardNumber = parseInt(minCardNumberString?.replace(/\D/g, '') || '0');
        const nextBSCCards: Card[] = [];
        const prevBSC: Card[] = [];
        bscCards.forEach((card) => {
          const cardNo = parseInt(card.cardNo.replace(/\D/g, '') || '0');
          // log(
          //   `cardNo >= minCardNumber && cardNo <= maxCardNumber: ${cardNo} >= ${minCardNumber} && ${cardNo} <= ${maxCardNumber} === ${cardNo >= minCardNumber && cardNo <= maxCardNumber}`,
          // );
          if (cardNo >= minCardNumber && cardNo <= maxCardNumber) {
            nextBSCCards.push(card);
          } else {
            prevBSC.push(card);
          }
        });
        bscCards = prevBSC;
        const nextCards = findVariations(nextBSCCards, nextSLCards);
        // log(`After sorting ${nextCards.bscBase.length} are in Series 2 and ${bscCards.length} are in Series 1`);
        // log(`Next Cards: ${nextCards.slBase.length} SL Cards and ${nextCards.bscBase.length} BSC Cards`);
        // log(`Next SL Cards: ${nextCards.slBase.map((card) => card.cardNumber)}`);
        // log(`Next BSC Cards: ${nextCards.bscBase.map((card) => card.cardNo)}`);
        const nextProducts = await buildProducts(nextSeries.category, nextCards);
        builtProducts += nextProducts.length;
        // log('builtProducts', builtProducts);
        cards = findVariations(bscCards, slCards);
      }
    } else {
      cards = {
        bsc: bscCards,
        sl: [],
        bscBase: bscCards,
        bscVariations: {},
        slBase: [],
        slVariations: {},
      };
    }
    // log(`Original SL: ${cards.slBase.map((card) => card.cardNumber)} `);
    // log(`Original BSC  ${cards.bscBase.map((card) => card.cardNo)}`);
    const products = await buildProducts(category, cards);
    builtProducts += products.length;
    finish(`Built ${builtProducts} products for ${category.name}`);
  } catch (e) {
    error(e);
    throw e; // Re-throw so caller can handle
  }
}

export function findVariations(bscCards: Card[], slCards: SLCard[]): SiteCards {
  const cards: SiteCards = {
    bsc: bscCards,
    sl: slCards,
    bscBase: [],
    bscVariations: {},
    slBase: [],
    slVariations: {},
  };

  bscCards.forEach((card) => {
    if (
      cards.bscBase.find((bscCard) => bscCard.cardNo === card.cardNo) ||
      cards.bscVariations[card.cardNo]?.find((bscCard) => bscCard.cardNo === card.cardNo)
    ) {
      card.cardNo = `${card.cardNo}b`;
    }

    if (
      card.playerAttribute.indexOf('VAR') > -1 ||
      card.playerAttribute.indexOf('ERR') > -1 ||
      card.playerAttribute.indexOf('COR') > -1 ||
      (card.cardNo.match(/[a-z]$/) && bscCards.find((bscCard) => bscCard.cardNo === card.cardNo.slice(0, -1)))
    ) {
      const baseCardNumber = card.cardNo.match(/[a-z]$/) ? card.cardNo.slice(0, -1) : card.cardNo;
      if (
        card.playerAttribute.indexOf('COR') > -1 &&
        !cards.bscBase.find((bscCard) => bscCard.cardNo === baseCardNumber)
      ) {
        cards.bscBase.push(card);
      } else {
        if (!cards.bscVariations[baseCardNumber]) {
          cards.bscVariations[baseCardNumber] = [];
        }
        if (cards.bscVariations[baseCardNumber].find((bscCard) => bscCard.cardNo === card.cardNo)) {
          card.cardNo = `${baseCardNumber}b`;
        }
        cards.bscVariations[baseCardNumber].push(card);
      }
    } else {
      cards.bscBase.push(card);
    }
  });

  slCards.forEach((card) => {
    if (card.title.indexOf('VAR') > -1) {
      const baseCardNumber = card.cardNumber.match(/[a-z]$/) ? card.cardNumber.slice(0, -1) : card.cardNumber;
      if (!cards.slVariations[baseCardNumber]) {
        cards.slVariations[baseCardNumber] = [];
      }
      cards.slVariations[baseCardNumber].push(card);
    } else {
      cards.slBase.push(card);
    }
  });

  if (cards.slBase.length !== cards.bscBase.length) {
    const extraBSC = cards.bscBase.filter((card) => !cards.slBase.find((slCard) => slCard.cardNumber === card.cardNo));
    log(
      `There are ${extraBSC.length} BSC cards between ${_.minBy(extraBSC, 'cardNo')?.cardNo} and ${_.maxBy(extraBSC, 'cardNo')?.cardNo}`,
    );
    // log('Extra Cards in BSC: ', extraBSC.map((card) => card.cardNo));
    const extraSL = cards.slBase.filter((slCard) => !cards.bscBase.find((card) => slCard.cardNumber === card.cardNo));
    log(
      `There are ${extraSL.length} SL cards between ${_.minBy(extraSL, 'cardNo')?.cardNumber} and ${_.maxBy(extraSL, 'cardNo')?.cardNumber}`,
    );
    // log('Extra Cards in SL: ', extraSL.map((card) => card.cardNumber));
  }
  // log(
  //   `Variations in BSC: ${Object.keys(cards.bscVariations).length} Variations in SL: ${Object.keys(cards.slVariations).length}`,
  // );
  // log(`BSC Variations: ${Object.keys(cards.bscVariations)}`);
  // log(
  //   `BSC First Variations: |${Object.keys(cards.bscVariations)[0]}| type ${typeof Object.keys(cards.bscVariations)[0]}`,
  // );
  // log(`BSC Var 1: ${cards.bscVariations[1]}`);
  // log(`BSC Var '1': ${cards.bscVariations['1']}`);
  // log(`BSC Var stupid: ${cards.bscVariations[Object.keys(cards.bscVariations)[0]]}`);
  // log(`BSC Base CardNo: ${cards.bscBase[0].cardNo} type: ${typeof cards.bscBase[0].cardNo}`);
  // log(cards.bscVariations);

  return cards;
}

type CardProduct = object;

type SiteCards = {
  bsc: Card[];
  sl: SLCard[];
  bscBase: Card[];
  bscVariations: { [key: string]: Card[] };
  slBase: SLCard[];
  slVariations: { [key: string]: SLCard[] };
};

async function buildProducts(category: Category, inputCards: SiteCards): Promise<CardProduct[]> {
  const { update, finish, error } = showSpinner('buildProducts', 'Building Products');
  const products: CardProduct[] = [];
  try {
    update('Building Products');
    const slCardOptions: AskSelectOption[] = [
      { name: 'None', value: 'None' },
      ...inputCards.slBase.map(
        (card): AskSelectOption => ({
          value: card.title,
          name: `${card.cardNumber} - ${card.title}`,
        }),
      ),
    ];

    interface TempCard extends Card {
      sportlots?: string;
      variations?: Variation[];
    }

    const cards: TempCard[] = await Promise.all(
      inputCards.bscBase.map(async (card): Promise<TempCard> => {
        let slCard = inputCards.slBase.find((slCard) => slCard.cardNumber === card.cardNo);
        const rtn: TempCard = { ...card };
        if (
          !slCard &&
          category.metadata?.card_number_prefix &&
          card.cardNo.startsWith(category.metadata.card_number_prefix)
        ) {
          const searchNumber = card.cardNo.slice(category.metadata.card_number_prefix.length);
          slCard = inputCards.slBase.find((slCard) => slCard.cardNumber === searchNumber);
        }
        if (slCard) {
          rtn.sportlots = slCard.title;
        } else if (slCardOptions.length > 0) {
          rtn.sportlots = await ask(
            `Which Sportlots Card maps to ${card.setName} ${card.variantName} #${
              card.cardNo
            } ${card.players.join(' ')}?`,
            card.players[0],
            { selectOptions: slCardOptions },
          );
        }
        return rtn;
      }),
    );

    const existing = await getProductCardNumbers(category.id);
    const queue = new Queue({ concurrency: 1, results: products, autostart: true });
    let hasQueueError: boolean | Error = false;

    queue.addEventListener('error', (event: unknown): void => {
      // @ts-expect-error no idea how to type this thing
      hasQueueError = event.error;
      log(`Queue error: `, error);
      queue.stop();
    });

    let count = 0;

    cards
      .filter((card: TempCard) => !existing.includes(card.cardNo))
      .forEach((card) =>
        queue.push(async () => {
          try {
            const product = await buildProductFromBSCCard(card, category);
            const variationsBSC = inputCards.bscVariations[card.cardNo];
            const variationsSL = inputCards.slVariations[card.cardNo];
            const variations: Variation[] = [
              {
                title: product.title,
                sku: product.metadata?.sku,
                metadata: {
                  ...product.metadata,
                  features: product.metadata?.features,
                  description: `${product.description} <br><br><ul>${product.metadata?.features.map((feature: string) => `<li>${feature.trim()}</li>`).join('')}</ul>`,
                  isBase: true,
                },
              },
            ];
            if (variationsBSC) {
              const counter: string = 'a';
              for (const variation of variationsBSC) {
                const slVariation = variationsSL?.shift();
                const metadata = { ...product.metadata };

                metadata.variationName = slVariation?.title.match(/\[(.*?)\]/)?.[1] || 'Variation';
                metadata.cardNumber = variations.find((v) => v.sku === `${category.metadata?.bin}|${variation.cardNo}`)
                  ? `${variation.cardNo}${counter}`
                  : variation.cardNo;
                metadata.cardName = `${metadata.cardName} ${metadata.variationName}`;
                metadata.bsc = card.id;
                metadata.sku = `${category.metadata?.bin}|${variation.cardNo}`;
                if (metadata.features) {
                  metadata.features = [...metadata.features, 'Variation'];
                } else {
                  metadata.features = ['Variation'];
                }
                if (slVariation) {
                  metadata.sportlots = slVariation.title;
                }

                metadata.features = _.uniq(metadata.features || []).filter((feature) => feature);
                const titles = await getTitles({ ...metadata, ...category.metadata });
                metadata.description = `${titles.longTitle} <br><br><ul>${metadata.features.map((feature: string) => `<li>${feature}</li>`).join('')}</ul>`;

                variations.push({
                  title: titles.title,
                  sku: `${category.metadata?.bin}|${variation.cardNo}`,
                  metadata: metadata,
                });
              }
            }
            if (variationsSL) {
              for (const slVariation of variationsSL) {
                const metadata = { ...product.metadata };

                metadata.variationName = slVariation.title.match(/\[(.*?)\]/)?.[1];

                metadata.cardNumber = slVariation.cardNumber + ['a', 'b', 'c', 'd', 'e', 'f', 'g'][variations.length];
                metadata.cardName = `${metadata.cardName} ${metadata.variationName}`;
                metadata.sku = `${category.metadata?.bin}|${metadata.cardNumber}`;
                if (metadata.features) {
                  metadata.features = [...metadata.features, 'Variation'];
                } else {
                  metadata.features = ['Variation'];
                }
                metadata.sportlots = slVariation.title;

                //remove duplicates from metadata.features
                metadata.features = _.uniq(metadata.features || []).filter((feature) => feature);

                const titles = await getTitles({ ...metadata, ...category.metadata });
                metadata.description = `${titles.longTitle} <br><br><ul>${metadata.features.map((feature: string) => `<li>${feature.trim()}</li>`).join('')}</ul>`;
                variations.push({
                  title: titles.title,
                  sku: `${category.metadata?.bin}|${metadata.cardNumber}`,
                  metadata: metadata,
                });
              }
            }
            const result = await createProduct(product, variations);
            update(`Saving Product ${++count}/${cards.length}`);
            return result;
          } catch (e) {
            error(e);
            // createProduct now handles duplicate handle errors by updating existing products
            // So if we get here, it's a different error - rethrow to stop processing
            throw e;
          }
        }),
      );

    if (queue.length > 0 && !hasQueueError) {
      await new Promise((resolve) => queue.addEventListener('end', resolve));
      finish('Products Built');
      if (hasQueueError) {
        throw hasQueueError;
      }
    } else if (hasQueueError) {
      throw hasQueueError;
    } else {
      finish('Products Built');
    }
  } catch (e) {
    error(e);
  }
  return products;
}
