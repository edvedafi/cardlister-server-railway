import { getCategories, getRootCategory } from './medusa';
import type { ProductCategory } from '@medusajs/client-types';

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
