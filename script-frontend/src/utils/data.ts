import { getCategories, getProduct, getProductVariant, getRootCategory } from './medusa';
import type { Order, ProductCategory } from '@medusajs/client-types';
import { useSpinners } from './spinners';
import chalk, { type ChalkInstance } from 'chalk';
import _ from 'lodash';

const color = chalk.greenBright;
const { showSpinner, log } = useSpinners('data-utils', color);

export const isYes = (str: boolean | string | undefined) =>
  (typeof str === 'boolean' && str) ||
  (typeof str === 'string' && ['yes', 'YES', 'y', 'Y', 'Yes', 'YEs', 'YeS', 'yES'].includes(str));

export const isNo = (str: boolean | string | undefined) =>
  (typeof str === 'boolean' && !str) || (typeof str === 'string' && ['no', 'NO', 'n', 'N', 'No'].includes(str));

export const titleCase = (str: string | null | undefined): string => {
  if (!str) {
    return '';
  }
  try {
    return str
      .trim()
      .split(' ')
      .map((word) => {
        if (word.length > 3 && word.toLowerCase().startsWith('mc')) {
          return 'Mc' + word[2].toUpperCase() + word.slice(3).toLowerCase();
        } else {
          return word[0].toUpperCase() + word.slice(1).toLowerCase();
        }
      })
      .join(' ')
      .split('.')
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join('.')
      .split("'")
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join("'");
  } catch (e) {
    console.log('error title casing', str);
    throw e;
  }
};

export const psaGrades: { [key: number]: string } = {
  10: 'GEM-MT',
  9.5: 'MINT',
  9: 'MINT',
  8.5: 'NM-MT',
  8: 'NM-MT',
  7.5: 'NM',
  7: 'NM',
  6.5: 'EX-MT',
  6: 'EX-MT',
  5.5: 'EX',
  5: 'EX',
  4.5: 'VG-EX',
  4: 'VG-EX',
  3.5: 'VG',
  3: 'VG',
  2.5: 'G',
  2: 'G',
  1.5: 'PF',
  1: 'PF',
  0.5: 'PF',
  0: 'PO',
};

let _inserts: string[];

export async function getInserts(): Promise<string[]> {
  if (!_inserts) await cacheCategoryInfo();
  if (!_inserts) throw new Error('Brands not found');
  return _inserts;
}

let _brands: string[];

export async function getBrands(): Promise<string[]> {
  if (!_brands) await cacheCategoryInfo();
  if (!_brands) throw new Error('Brands not found');
  return _brands;
}

let _sets: string[];

export async function getSets(): Promise<string[]> {
  if (!_sets) await cacheCategoryInfo();
  if (!_sets) throw new Error('Sets not found');
  return _sets;
}

let _sports: string[];

export async function getSports(): Promise<string[]> {
  if (!_sports) await cacheCategoryInfo();
  if (!_sports) throw new Error('Sports not found');
  return _sports;
}

async function cacheCategoryInfo() {
  _brands = [];
  _sets = [];
  _sports = [];
  _inserts = [];
  const root: string = await getRootCategory();
  const sportCategories: ProductCategory[] = await getCategories(root);
  for (const sport of sportCategories) {
    _sports.push(sport.name.toLowerCase());
    const yearCategories: ProductCategory[] = await getCategories(sport.id);
    for (const year of yearCategories) {
      const manufactureCategories: ProductCategory[] = await getCategories(year.id);
      for (const manufacture of manufactureCategories) {
        _brands.push(manufacture.name.toLowerCase());
        const setCategories: ProductCategory[] = await getCategories(manufacture.id);
        for (const set of setCategories) {
          _sets.push(set.name.toLowerCase());
          const subCategoriesOfSet: ProductCategory[] = await getCategories(set.id);
          for (const subCategory of subCategoriesOfSet) {
            if (subCategory.name.toLowerCase() === 'insert') {
              const insertCategories: ProductCategory[] = await getCategories(subCategory.id);
              for (const insert of insertCategories) {
                _inserts.push(insert.name.toLowerCase());
              }
            }
          }
        }
      }
    }
  }
}

type DisplayableRow = {
  sport: string;
  year: string;
  setName: string;
  parallel: string;
  insert: string;
  cardNumber: string;
  quantity: number | string;
  title: string;
  platform: string;
};
type DisplayRows = {
  [key: string]: DisplayableRow[];
};

export type OldSale = DisplayableRow & { sku: string; platform: string };

export async function buildTableData(orders: Order[], oldSales: OldSale[]): Promise<DisplayableRow[]> {
  const { finish, error, update } = showSpinner('buildTableData', 'Building table data');
  const finalDisplay: DisplayableRow[] = [];

  try {
    const divider: DisplayableRow = {
      sport: '--------',
      year: '----',
      setName: '---',
      parallel: '--------',
      insert: '------',
      cardNumber: '-----',
      quantity: '-----',
      title: '-----',
      platform: '--------',
    };
    update('Building Display Rows');
    const displayable: DisplayRows = (
      await Promise.all(
        orders
          .flatMap((order: Order) => order.items?.map((item) => ({ ...item, order })))
          .filter((item) => item)
          .map(async (item): Promise<DisplayableRow> => {
            if (item) {
              let variant = item.variant;
              if (item.variant_id && !variant) {
                variant = await getProductVariant(item.variant_id);
              }
              if (variant) {
                let product;
                try {
                  product =
                    variant.product &&
                    variant.product.metadata &&
                    variant.product.categories &&
                    variant.product.categories.length > 0
                      ? variant.product
                      : await getProduct(variant.product_id);
                } catch (e) {
                  log('Error getting product', item.title, item.variant_id);
                }
                if (product && product.metadata) {
                  const category = product.categories?.[0];
                  if (category && category.metadata) {
                    return {
                      sport: category.metadata.sport,
                      year: category.metadata.year,
                      setName: category.metadata.setName,
                      parallel: category.metadata.parallel,
                      insert: category.metadata.insert,
                      cardNumber: product.metadata.cardNumber,
                      quantity: item.quantity,
                      title: product.title,
                      platform: item.order.metadata?.platform || '???',
                    };
                  } else {
                    return {
                      sport: '?',
                      year: '?',
                      setName: '?',
                      parallel: '?',
                      insert: '?',
                      cardNumber: '?',
                      quantity: item.quantity,
                      title: item.title,
                      platform: item.order.metadata?.platform || '???',
                    };
                  }
                } else {
                  return {
                    sport: '?',
                    year: '?',
                    setName: '?',
                    parallel: '?',
                    insert: '?',
                    cardNumber: '?',
                    quantity: item.quantity,
                    title: item.title,
                    platform: item.order.metadata?.platform || '???',
                  };
                }
              } else {
                const fuzzy = oldSales.find((sale) => sale.sku === item.metadata?.sku);
                if (fuzzy) {
                  return {
                    sport: fuzzy.sport,
                    year: fuzzy.year,
                    setName: fuzzy.setName,
                    parallel: fuzzy.parallel,
                    insert: fuzzy.insert,
                    cardNumber: fuzzy.cardNumber,
                    quantity: item.quantity,
                    title: item.title,
                    platform: item.order.metadata?.platform || '???',
                  };
                } else {
                  return {
                    sport: '?',
                    year: '?',
                    setName: '?',
                    parallel: '?',
                    insert: '?',
                    cardNumber: '?',
                    quantity: item.quantity,
                    title: item.title,
                    platform: item.order.metadata?.platform || '???',
                  };
                }
              }
            } else {
              throw new Error('Item not found');
            }
          }),
      )
    )
      .filter((item) => item)
      .reduce((items: DisplayableRow[], item: DisplayableRow): DisplayableRow[] => {
        const existing = items.find((i) => i.title === item.title);
        if (!existing) {
          items.push(item);
        } else {
          existing.quantity = <number>existing.quantity + <number>item.quantity;
        }
        return items;
      }, [])
      .reduce((items: DisplayRows, item: DisplayableRow): DisplayRows => {
        const key = JSON.stringify({
          sport: item.sport,
          year: item.year,
          setName: item.setName,
          parallel: item.parallel,
          insert: item.insert,
        });
        if (!items[key]) {
          items[key] = [item];
        } else {
          items[key].push(item);
        }
        return items;
      }, {});

    update('Adding Dividers');
    Object.values(displayable).forEach((cards) =>
      cards.forEach((card) => {
        Object.keys(divider).forEach((key) => {
          // @ts-expect-error - I know this is a bad idea, but it must be done
          divider[key] = '-'.repeat(Math.max(parseInt(card[key]?.length || 0), parseInt(divider[key]?.length || 0)));
        });
      }),
    );

    let color = chalk.magentaBright;
    const orderColors: { [key: string]: ChalkInstance } = {};
    const orderColor = (orderId: string) => {
      if (!orderColors[orderId]) {
        orderColors[orderId] = [
          chalk.red,
          // chalk.green,
          chalk.yellow,
          chalk.blue,
          // chalk.magenta,
          chalk.cyan,
          chalk.white,
          chalk.redBright,
          // chalk.greenBright,
          chalk.yellowBright,
          chalk.blueBright,
          // chalk.magentaBright,
          chalk.cyanBright,
          chalk.whiteBright,
          chalk.bgRed,
          chalk.bgGreen,
          chalk.bgYellow,
          chalk.bgBlue,
          chalk.bgMagenta,
          chalk.bgCyan,
          chalk.bgWhite,
          chalk.bgBlackBright,
          chalk.bgRedBright,
          chalk.bgGreenBright,
          chalk.bgYellowBright,
          chalk.bgBlueBright,
          chalk.bgMagentaBright,
          chalk.bgCyanBright,
          chalk.bgWhiteBright,
        ][Object.keys(orderColors).length];
      }
      return orderColors[orderId];
    };

    update('Setting colors');
    _.orderBy(
      Array.from(Object.keys(displayable).map((key) => JSON.parse(key))),
      ['sport', 'year', 'setName', 'parallel', 'insert'],
      ['asc', 'desc', 'asc', 'asc', 'asc'],
    ).forEach((key, i) => {
      if (i > 0) {
        finalDisplay.push(divider);
      }

      if (key.insert) {
        if (key.parallel) {
          color = chalk.redBright;
        } else {
          color = chalk.blueBright;
        }
      } else if (key.parallel) {
        color = chalk.greenBright;
      } else {
        color = chalk.whiteBright;
      }

      const cards = displayable[JSON.stringify(key)];
      if (cards) {
        _.orderBy(
          cards,
          [
            (card) => {
              try {
                const cardNo = parseInt(card.cardNumber);
                if (isNaN(cardNo)) {
                  return card.cardNumber;
                } else {
                  return cardNo;
                }
              } catch (e) {
                return card.cardNumber;
              }
            },
          ],
          ['asc'],
        ).forEach((card) => {
          Object.keys(card).forEach(
            (cardKey) =>
              // @ts-expect-error - Crazy reflective type code that I have no idea what the types are and its ok to not know
              (card[cardKey] =
                cardKey === 'platform'
                  ? orderColor(card.platform)(card.platform)
                  : cardKey === 'sport'
                    ? (
                        {
                          football: chalk.green,
                          Football: chalk.green,
                          baseball: chalk.red,
                          Baseball: chalk.red,
                          Basketball: chalk.yellow,
                          basketball: chalk.yellow,
                          Hockey: chalk.blue,
                          hockey: chalk.blue,
                          other: chalk.cyanBright,
                          MulitSport: chalk.cyanBright,
                          mulitsport: chalk.cyanBright,
                          MultiSport: chalk.cyanBright,
                          '?': chalk.white,
                        }[card.sport] || chalk.cyanBright
                      )(card.sport)
                    : // @ts-expect-error - Crazy reflective type code that I have no idea what the types are and its ok to not know
                      color(card[cardKey])),
          );
          finalDisplay.push(card);
        });
      }
    });
  } catch (e) {
    error(e);
  }
  finish();
  return finalDisplay;
}
