import type { Category, Metadata } from '../models/setInfo';
import { ask } from '../utils/ask';
import type { Product } from '../models/cards';
import type { Card } from '../models/bsc';
import { isNo, isYes, psaGrades } from '../utils/data';

export async function buildProductFromBSCCard(card: Card, set: Category): Promise<Product> {
  let product: Product = {
    type: 'Card',
    categories: set,
    weight: 1,
    length: 4,
    width: 6,
    height: 1,
    origin_country: 'US',
    material: 'Card Stock',

    // tags: need to get form BSC and asking
    metadata: {
      cardNumber: card.cardNo,
      player: card.players,
      teams: card.teamName || 'Unknown',
      sku: `${set.metadata.bin}|${card.cardNo}`,
      size: 'Standard',
      thickness: '20pt',
      bsc: card.id,
      printRun: card.printRun,
      autograph: card.autograph,
    },
  };
  if (card.sportlots) {
    product.metadata.sportlots = card.sportlots;
  }
  const titles = await getTitles({ ...product, ...set.metadata, ...product.metadata });
  product.title = titles.title;
  product.description = titles.longTitle;
  product.metadata.cardName = await getCardName(product, set);

  product.size = 'Standard';
  product.material = 'Card Stock';
  product.thickness = '20pt';
  product.lbs = 0;
  product.oz = 1;
  product.length = 6;
  product.width = 4;
  product.depth = 1;

  return product;
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
export async function getTitles(card: Metadata) {
  const maxTitleLength = 80;

  const titles: Partial<Titles> = {};

  let insert = add(card.insert, 'Insert');
  let parallel = add(card.parallel, 'Parallel');
  let features = add(card.features).replace(' | ', '');
  let printRun = card.printRun ? ` /${card.printRun}` : '';
  let setName = card.setName;
  let teamDisplay = card.teams;
  // @ts-ignore
  let graded = isYes(card.graded) ? ` ${card.grader} ${card.grade} ${psaGrades[card.grade]}` : '';

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

  return titles;
}

//generate a 60 character card name
async function getCardName(card: Product, category: Category): Promise<string> {
  if (!card.title) throw 'Must have Title to generate Card Name';

  const maxCardNameLength = 60;
  let cardName = card.title.replace(' | ', ' ');
  let insert = add(category.metadata.insert);
  let parallel = add(category.metadata.parallel);
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
