import { getCategory, getRootCategory } from './utils/medusa';
import type { ProductCategory } from '@medusajs/client-types';

const categoryId = process.argv[2];

if (!categoryId) {
  console.error('Usage: tsx src/lookupCategory.ts <category_id>');
  process.exit(1);
}

// Add pcat_ prefix if not present
const fullId = categoryId.startsWith('pcat_') ? categoryId : `pcat_${categoryId}`;

async function main() {
  const category = await getCategory(fullId);
  const rootId = await getRootCategory();

  // Walk up parent chain
  const hierarchy: ProductCategory[] = [category];
  let current: ProductCategory | undefined = category;

  while (current?.parent_category_id && current.parent_category_id !== rootId) {
    current = await getCategory(current.parent_category_id);
    hierarchy.push(current);
  }

  hierarchy.reverse();

  // Map hierarchy: Sport → Year → Brand → Set → VariantType → VariantName
  const labels = ['Sport', 'Year', 'Brand', 'Set', 'Variant Type', 'Variant Name'];

  console.log('\n--- Category Info ---');
  console.log(`ID: ${fullId}`);
  console.log('');

  for (let i = 0; i < hierarchy.length; i++) {
    const label = labels[i] ?? `Level ${i}`;
    console.log(`${label}: ${hierarchy[i].name}`);
  }

  // Show relevant metadata from the category itself
  const meta = category.metadata as Record<string, unknown> | undefined;
  if (meta) {
    console.log('\n--- Metadata ---');
    const interestingKeys = [
      'year', 'sport', 'brand', 'setName',
      'isInsert', 'insert', 'insert_xs',
      'isParallel', 'parallel', 'parallel_xs',
      'printRun', 'autograph', 'features',
      'bin', 'sportlots', 'bsc', 'card_number_prefix',
    ];
    for (const key of interestingKeys) {
      if (meta[key] !== undefined && meta[key] !== null) {
        const val = Array.isArray(meta[key]) ? (meta[key] as unknown[]).join(', ') : meta[key];
        console.log(`  ${key}: ${val}`);
      }
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
