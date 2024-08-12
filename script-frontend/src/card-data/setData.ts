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
import { getSLCards, getSLSport, getSLBrand, getSLYear, getSLSet } from '../listing-sites/sportlots';
import { ask, type AskSelectOption } from '../utils/ask';
import type { Category, Metadata, SetInfo } from '../models/setInfo';
import {
  getCategories,
  getProductCardNumbers,
  createProduct,
  setCategoryActive,
  createCategory,
  createCategoryActive,
  updateCategory,
  getRootCategory,
} from '../utils/medusa.js';
import { getGroup } from '../listing-sites/firebase.js';
import Queue from 'queue';
import { type Card } from '../models/bsc';
import { type SLCard } from '../models/cards';
import { buildProductFromBSCCard } from './cardData';
import { getPricing } from './pricing';
import type { MoneyAmount } from '@medusajs/client-types';

const { showSpinner, log } = useSpinners('setData', chalk.whiteBright);

export async function findSet(allowParent = false): Promise<SetInfo> {
  const { update, finish, error } = showSpinner('findSet', 'Finding Set');
  const setInfo: Partial<SetInfo> = { handle: '', metadata: {} };

  const askNew = async (display: string, options: AskSelectOption[]) => {
    const selectOptions = options.sort((a, b) => a.name.localeCompare(b.name));
    selectOptions.push({ value: 'New', name: 'New' });
    if (allowParent) {
      selectOptions.push({ value: 'Parent', name: 'Parent' });
    }
    const response = await ask(display, undefined, { selectOptions: selectOptions });
    if (response === 'New') {
      return null;
    }
    if (response === 'Parent') {
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
      setInfo.sport = await updateCategory(setInfo.sport.id, { ...setInfo.sport.metadata, sportlots: slSport.key });
    }
    if (!setInfo.sport) throw new Error('Sport not found');
    if (!setInfo.sport?.metadata?.bsc) {
      update('Add BSC to Sport');
      const bscSport = await getBSCSportFilter(setInfo.sport.name);
      setInfo.sport = await updateCategory(setInfo.sport?.id, { ...setInfo.sport?.metadata, bsc: bscSport?.filter });
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
      setInfo.handle = `${setInfo.brand.handle}-${bscSet.name}`;
      setInfo.set = await createCategory(bscSet.name, setInfo.brand.id, setInfo.handle, { bsc: bscSet.filter });
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
          bin: (
            await getGroup({
              sport: setInfo.sport?.name,
              manufacture: setInfo.brand.name,
              year: setInfo.year.name,
              setName: setInfo.set.name,
            })
          ).bin,
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

        const bscVariantName: BSCFilterResponse = await getBSCVariantNameFilter(setInfo);
        if (isInsert && !isParallel) {
          isParallel = await ask('Is this a parallel of an insert?', false);
        }
        setInfo.handle = `${setInfo.variantType.handle}-${bscVariantName.name}`;
        const metaData: Metadata = {
          bsc: bscVariantName.filter,
          isInsert,
          isParallel,
          bin: (
            await getGroup({
              sport: setInfo.sport?.name,
              manufacture: setInfo.brand.name,
              year: setInfo.year.name,
              setName: setInfo.set.name,
              insert: isInsert ? bscVariantName.name : null,
              parallel: isParallel ? bscVariantName.name : null,
            })
          ).bin,
          sport: setInfo.sport?.name,
          brand: setInfo.brand.name,
          year: setInfo.year.name,
          setName: setInfo.set.name,
          insert: isInsert ? bscVariantName.name : null,
          parallel: isParallel ? bscVariantName.name : null,
          ...(await updateSetDefaults()),
        };

        setInfo.variantName = await createCategory(
          bscVariantName.name,
          setInfo.variantType.id,
          setInfo.handle,
          metaData,
        );
      }
      if (!setInfo.variantName) throw new Error('Variant Name not found');
      const updates: Metadata = {};
      if (!setInfo.variantName?.metadata?.sportlots) {
        updates.sportlots = await getSLSet(setInfo as SetInfo);
      }
      let description;
      if (!setInfo.variantName?.description) {
        description = await ask('Set Title', `${setInfo.year.name} ${setInfo.set.name} ${setInfo.variantName?.name}`);
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

export async function updateSetDefaults(metadata: Metadata = {}) {
  const { finish, error } = showSpinner('updateSetDefaults', 'Updating Set Defaults');

  log(`Metadata ${JSON.stringify(metadata)}`);
  try {
    const update = async (field: string) => {
      const response = await ask(field, metadata[field]);
      if (response) {
        if (response.indexOf('|') > -1) {
          metadata[field] = response.split('|').map((r: string) => r.trim());
        } else {
          metadata[field] = response;
        }
      }
    };

    await update('card_number_prefix');
    await update('features');
    await update('printRun');

    metadata.prices = await getPricing(<MoneyAmount[]>metadata.prices);

    finish();
  } catch (e) {
    error(e);
  }
  return metadata;
}

export async function getCategoriesAsOptions(parent_category_id: string) {
  const categories = await getCategories(parent_category_id);
  return categories.map((category: Category) => ({
    value: category,
    name: category.name,
  }));
}

export async function buildSet(setInfo: SetInfo) {
  const { update, finish, error } = showSpinner('buildSet', 'Building Set');
  try {
    update('Building Set');
    const category: Category = setInfo.variantName || setInfo.variantType;
    const cards = await getBSCCards(category);
    const slCards = await getSLCards(setInfo, category);
    if (cards.length !== slCards.length) throw `Set counts do not match! BSC: ${cards.length} SL: ${slCards.length}`;
    const products = await buildProducts(category, cards, slCards);
    finish(`Built ${products.length} products for ${category.name}`);
  } catch (e) {
    error(e);
  }
}

type CardProduct = object;

async function buildProducts(category: Category, bscCards: Card[], slCards: SLCard[]): Promise<CardProduct[]> {
  const { update, finish, error } = showSpinner('buildProducts', 'Building Products');
  const products: CardProduct[] = [];
  try {
    update('Building Products');
    const slCardOptions: AskSelectOption[] = slCards.map(
      (card): AskSelectOption => ({
        value: card.cardNumber,
        name: `${card.cardNumber} - ${card.title}`,
      }),
    );
    if (slCards.length === 0) {
      throw 'No Sportlots cards found';
    } else {
      log(slCards);
    }

    interface TempCard extends Card {
      sportlots?: string;
    }

    const cards: TempCard[] = await Promise.all(
      bscCards.map(async (card): Promise<TempCard> => {
        const slCard = slCards.find((slCard) => slCard.cardNumber === card.cardNo);
        const rtn: TempCard = { ...card };
        if (!slCard) {
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
            const result = await createProduct(product);
            update(`Saving Product ${++count}/${cards.length}`);
            return result;
          } catch (e) {
            error(e);
            throw e;
          }
        }),
      );

    if (queue.length > 0 && !hasQueueError) {
      await new Promise((resolve) => queue.addEventListener('end', resolve));
      finish('Products Built');
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
