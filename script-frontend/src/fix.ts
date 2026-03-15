import dotenv from 'dotenv';
import 'zx/globals';
import { type UpdateSpinner, useSpinners } from './utils/spinners';
import { clearBSC, shutdownBuySportsCards } from './old-scripts/bsc';
import { parseArgs } from './utils/parseArgs';
import { findSet } from './card-data/setData';
import { ask } from './utils/ask';
import { fixVariants, getCategory, getProducts, updateCategory, updateProductVariantMetadata, updateVariantTitle } from './utils/medusa';
import { cleanFeatures, getTitles, setAllPricesToCommons } from './card-data/cardData';
import type { Product, ProductCategory } from '@medusajs/client-types';

const args = parseArgs(
  {
    string: ['y'],
    boolean: ['b', 'i', 'c', 'f', 't', 'e'],
    alias: {
      y: 'year',
      b: 'bsc',
      i: 'images',
      c: 'commons',
      f: 'features',
      t: 'titles',
      e: 'ebay',
    },
  },
  {
    year: 'Year',
    images: 'Fix images for all products',
    bsc: 'Remove all cards from year onBuySportsCards',
    commons: 'Set an entire set to common card pricing',
    features: 'Ensure features is a proper array on all products',
    titles: 'Regenerate variant titles using getTitles',
    ebay: 'Fix eBay sync issues: empty teams/franchise and long card names',
  },
);

$.verbose = false;

dotenv.config();

const { showSpinner } = useSpinners('Sync', chalk.cyanBright);
const { update, finish, error } = showSpinner('top-level', 'Running Fixes');

let isShuttingDown = false;
const shutdown = async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    await Promise.all([shutdownBuySportsCards()]);
  }
};

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
  process.on(
    signal,
    async () =>
      await shutdown().then(() => {
        process.exit();
      }),
  ),
);

const processByCategory = (work: (products: Product[]) => Promise<void>) => {
  const processCategory = async (category: ProductCategory) => {
    update(`Cleaning ${category.name}`);
    if (category.category_children.length > 0) {
      for (const child of category.category_children) {
        await processCategory(child);
      }
    } else {
      const products = await getProducts(category.id);
      update(category.name);
      await work(products);
    }
  };
  return processCategory;
};

try {
  if (args.images) {
    update('Product Images');
    const set = await findSet({ allowParent: true });
    update(set.category.name);
    await fixVariants(set.category.id);
  }
  if (args.commons) {
    update('Commons');
    const set = await findSet({ allowParent: true });
    update(set.category.name);
    update('Getting Products');
    const products = await getProducts(set.category.id);
    update('Setting Prices');
    await setAllPricesToCommons(products);
    update('Price set complete');
  }
  if (args.b) {
    update(`BuySportsCards [${args.y}]`);
    if (args.y.indexOf('-') > -1) {
      const [start, end] = args.y.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        update(`BuySportsCards [${i}]`);
        await clearBSC(`${i}`);
      }
    } else {
      await clearBSC(args.y);
    }
  }
  if (args.features) {
    update('Cleaning Features');
    const processor = processByCategory(cleanFeatures);
    const set = await findSet({ allowParent: true });
    await processor(set.category);
  }
  if (args.titles) {
    update('Fix Variant Titles');
    const set = await findSet({ allowParent: true });
    const fixTitles = async (category: ProductCategory) => {
      update(`Fixing titles in ${category.name}`);
      if (category.category_children.length > 0) {
        for (const child of category.category_children) {
          await fixTitles(child);
        }
      } else {
        const products = await getProducts(category.id);
        const cat = await getCategory(category.id);
        for (const product of products) {
          if (!product.variants) continue;
          for (const variant of product.variants) {
            const titles = await getTitles({ ...variant.metadata, ...cat.metadata });
            if (variant.title !== titles.title) {
              update(`${variant.title} => ${titles.title}`);
              await updateVariantTitle(product.id, variant.id, titles.title);
            }
          }
        }
      }
    };
    await fixTitles(set.category);
  }
  if (args.ebay) {
    update('Fix eBay Sync Issues');
    const set = await findSet({ allowParent: true });
    const MAX_CARD_NAME_LENGTH = 65;
    const fixEbayIssues = processByCategory(async (products: Product[]) => {
      for (const product of products) {
        if (!product.variants) continue;
        for (const variant of product.variants) {
          if (!variant.metadata) variant.metadata = {};
          const fixes: string[] = [];

          // Fix empty teams/franchise
          const teams = variant.metadata.teams || product.metadata?.teams;
          if (!teams || (typeof teams === 'string' && !teams.trim())) {
            const displayName = variant.metadata.cardName || product.metadata?.cardName || variant.sku;
            const teamAnswer = await ask(`Team for "${displayName}"`, 'Unknown');
            variant.metadata.teams = teamAnswer || 'Unknown';
            fixes.push(`teams=${variant.metadata.teams}`);
          } else if (!variant.metadata.teams) {
            variant.metadata.teams = teams;
            fixes.push(`teams=${teams}`);
          }

          // Fix card name too long
          const cardName = variant.metadata.cardName || product.metadata?.cardName;
          if (cardName && cardName.length > MAX_CARD_NAME_LENGTH) {
            variant.metadata.cardName = cardName.slice(0, MAX_CARD_NAME_LENGTH).trim();
            fixes.push(`cardName truncated from ${cardName.length} to ${variant.metadata.cardName.length} chars`);
          }

          if (fixes.length > 0) {
            await updateProductVariantMetadata(variant.id, product.id, variant.metadata);
            console.log(`${variant.sku}: ${fixes.join(', ')}`);
          }
        }
      }
    });
    await fixEbayIssues(set.category);
  }
} catch (e) {
  error(e);
} finally {
  finish();
  await shutdown();
  process.exit();
}
