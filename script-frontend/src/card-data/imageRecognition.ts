import vision, { type ImageAnnotatorClient } from '@google-cloud/vision';
import { isTeam, sports } from '../utils/teams.js';
import { getInserts, getBrands, getSets, titleCase } from '../utils/data';
import dotenv from 'dotenv';
import { type UpdateSpinner, useSpinners } from '../utils/spinners.js';
import type { Metadata, SetInfo } from '../models/setInfo';
import type { CropHints, ImageRecognitionResults } from '../models/cards';
import type { Product } from '@medusajs/client-types';
import { HfInference } from '@huggingface/inference';
import { protos } from '@google-cloud/vision';

const { showSpinner } = useSpinners('firebase', '#f4d02e');

dotenv.config();

const hf = new HfInference(process.env.HF_TOKEN);

const detectionFeatures = [
  { type: 'LABEL_DETECTION' },
  { type: 'LOGO_DETECTION' },
  { type: 'DOCUMENT_TEXT_DETECTION' },
  { type: 'OBJECT_LOCALIZATION' },
];

type SearchableData = {
  word: string;
  words: string[];
  wordCount: number;
  confidence: number;
  isFront: boolean;
  isNumber: boolean;
  lowerCase: string;
  set: boolean;
  isProperName: boolean;
};

type ProductMatchResult = {
  product: Product;
  score: number;
} | null;

type ProductMatchResultWithPerfect = {
  perfectMatch: ProductMatchResult;
  bestMatch: ProductMatchResult;
};

// Check if card number appears exactly in text (not as substring)
// e.g., "1234" matches "1234" but not "123", "234", or "12345"
function exactCardNumberMatch(cardNumber: string, text: string): boolean {
  if (!cardNumber || !text) return false;
  const normalizedCardNumber = cardNumber.toLowerCase().trim();
  const normalizedText = text.toLowerCase();
  
  // Escape special regex characters
  const escapedCardNumber = normalizedCardNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  // For exact matching, we need to ensure the card number appears as a complete number
  // This means it should be surrounded by non-digit characters or start/end of string
  // But we also need to handle cases where the card number might have letters (e.g., "BC8")
  
  // If card number is purely numeric, ensure it's not part of a larger number
  if (/^\d+$/.test(normalizedCardNumber)) {
    // Match the number only if it's:
    // - At start of string followed by non-digit
    // - Preceded by non-digit and followed by non-digit
    // - Preceded by non-digit and at end of string
    // - Standalone word (word boundaries work for numbers when they're separated)
    const exactMatchRegex = new RegExp(`(^|[^0-9])${escapedCardNumber}([^0-9]|$)`);
    return exactMatchRegex.test(normalizedText);
  } else {
    // For alphanumeric card numbers, use word boundaries
    const exactMatchRegex = new RegExp(`\\b${escapedCardNumber}\\b`);
    return exactMatchRegex.test(normalizedText);
  }
}

// Check if player name appears exactly in text (not as substring)
function exactPlayerNameMatch(playerName: string, text: string): boolean {
  if (!playerName || !text) return false;
  const normalizedPlayerName = playerName.toLowerCase().trim();
  const normalizedText = text.toLowerCase();
  
  // Check if the full player name appears in the text
  // This allows for the name to appear as part of a larger string but ensures
  // we're matching the full name, not just a substring
  return normalizedText.includes(normalizedPlayerName);
}

async function matchProductFromOCR(
  frontText: string,
  backText: string,
  products: Product[],
): Promise<ProductMatchResultWithPerfect> {
  type ProductScore = { product: Product; score: number; perfectMatch: boolean };
  const scoredProducts: ProductScore[] = [];

  for (const product of products) {
    let score = 0;
    const productMetadata = product.metadata || {};
    const cardNumber = productMetadata.cardNumber || '';
    const playerNames = (productMetadata.player || []) as string[];

    // Check for exact card number match on back
    const hasExactCardNumber = exactCardNumberMatch(cardNumber, backText);
    if (hasExactCardNumber) {
      score += 1000;
    }

    // Check each player name for exact matches
    let playerNameOnFront = false;
    let playerNameOnBack = false;
    let exactPlayerNameFront = false;
    let exactPlayerNameBack = false;

    for (const playerName of playerNames) {
      const normalizedPlayerName = playerName.toLowerCase();

      // Check for exact match on front
      if (exactPlayerNameMatch(playerName, frontText)) {
        playerNameOnFront = true;
        exactPlayerNameFront = true;
        score += 500;
      } else if (frontText.includes(normalizedPlayerName)) {
        // Substring match (for scoring but not perfect match)
        playerNameOnFront = true;
        score += 300;
      }

      // Check for exact match on back
      if (exactPlayerNameMatch(playerName, backText)) {
        playerNameOnBack = true;
        exactPlayerNameBack = true;
        score += 500;
      } else if (backText.includes(normalizedPlayerName)) {
        // Substring match (for scoring but not perfect match)
        playerNameOnBack = true;
        score += 300;
      }

      // Count occurrences of last name on back and increase score based on occurrences
      const lastName = normalizedPlayerName.split(' ').pop() || '';
      if (lastName) {
        const occurrences = (backText.match(new RegExp(lastName, 'g')) || []).length;
        if (occurrences > 0) {
          score += 50 * occurrences; // Increase score based on occurrences
        }
      }
    }

    // Perfect match: exact card number + exact player name on both front AND back
    const isPerfectMatch = hasExactCardNumber && exactPlayerNameFront && exactPlayerNameBack;
    if (isPerfectMatch) {
      score += 5000; // Perfect match bonus
    }

    // Finding player name on front but not back weighs heavier than just on back
    if (playerNameOnFront && !playerNameOnBack) {
      score += 200;
    } else if (!playerNameOnFront && playerNameOnBack) {
      score += 100;
    }

    scoredProducts.push({ product, score, perfectMatch: isPerfectMatch });
  }

  // Sort by score (highest first)
  scoredProducts.sort((a, b) => b.score - a.score);

  // Find perfect match (if any)
  const perfectMatch = scoredProducts.find((item) => item.perfectMatch);
  
  // Find best match (highest score)
  const bestMatch = scoredProducts[0];

  return {
    perfectMatch: perfectMatch && perfectMatch.score > 0 
      ? { product: perfectMatch.product, score: perfectMatch.score }
      : null,
    bestMatch: bestMatch && bestMatch.score > 0
      ? { product: bestMatch.product, score: bestMatch.score }
      : null,
  };
}

async function getTextFromImage(front: string, back: string | undefined = undefined, setData: Partial<SetInfo> = {}) {
  const { update, error, finish } = showSpinner(`image-recognition-${front}`, `Image Recognition ${front}`);

  let defaults: Partial<ImageRecognitionResults> = {
    sport: setData.metadata?.sport,
    setName: setData.metadata?.setName,
    brand: setData.metadata?.brand,
    year: setData.metadata?.year,
    insert: setData.metadata?.insert,
    raw: [front],
  };
  if (back) {
    defaults.raw?.push(back);
  }

  // New branch: If products exist, score them based on OCR results
  // Using EasyOCR for FREE text extraction (cost-effective alternative to Google Vision)
  if (setData.products && setData.products.length > 0) {
    try {
      update('Extracting text from card images using EasyOCR');
      const { extractTextWithOCR } = await import('../image-processing/ocr-extractor.js');
      
      const imagePaths = back ? [front, back] : [front];
      const ocrResults = await extractTextWithOCR(imagePaths);
      
      const frontText = ocrResults[0]?.text?.toLowerCase() || '';
      const backText = back ? (ocrResults[1]?.text?.toLowerCase() || '') : '';

      // Score products and find matches
      const matchResult = await matchProductFromOCR(frontText, backText, setData.products);

      // Use perfect match if available, otherwise use best match for default
      const matchToUse = matchResult.perfectMatch || matchResult.bestMatch;

      if (matchToUse) {
        const bestProduct = matchToUse.product;
        const bestMetadata = bestProduct.metadata || {};

        defaults = {
          ...defaults,
          player: bestMetadata.player || defaults.player,
          cardNumber: bestMetadata.cardNumber || defaults.cardNumber,
          printRun: bestMetadata.printRun || defaults.printRun,
          features: (bestMetadata.features || defaults.features) as string[],
          // Store whether this was a perfect match for use in matchCard
          _perfectMatch: matchResult.perfectMatch !== null,
          // Store the best match player name for default in matchCard
          _bestMatchPlayer: matchResult.bestMatch?.product.metadata?.player || defaults.player,
        };

        if (matchResult.perfectMatch) {
          finish(`Perfect match found: ${bestProduct.title} (score: ${matchToUse.score})`);
        } else {
          finish(`Best match found: ${bestProduct.title} (score: ${matchToUse.score}) - will prompt for confirmation`);
        }
        return defaults;
      }

      finish('No good product matches found, falling back to standard processing');
    } catch (e) {
      error(String(e));
      // Fall through to standard processing
    }
  }

  try {
    update('Loading Google Vision');
    const client: ImageAnnotatorClient = new vision.ImageAnnotatorClient();

    update(`Running Vision API on ${front}`);
    const [frontResult] = await client.annotateImage({
      image: {
        source: {
          filename: front,
        },
      },
      features: detectionFeatures,
      imageContext: {
        cropHintsParams: {
          aspectRatios: [1.390625, 0.7191011236],
        },
      },
    });

    update(`Running Vision API on ${back}`);
    const [backResult] = back
      ? await client.annotateImage({
          image: {
            source: {
              filename: back,
            },
          },
          features: detectionFeatures,
        })
      : [];

    update(`Gathering Crop Hints`);
    defaults = {
      ...defaults,
      crop: await getCropHints(client, front),
      cropBack: back ? await getCropHints(client, back) : undefined,
    };

    /**
     * Array of searchable data
     *
     * Confidence ratings, higher sorts first:
     *
     * 602.x: Logos on the front of the card
     * 601.x: Logos on the back of the card
     *
     * 302.x: Text on the front of the card
     * 301.x: Text on the back of the card
     *
     * 102.x: Labels on the front of the card
     * 101.x: Labels on the back of the card
     *
     * @type {*[]}
     *  word: The string to search
     *  words: Broken into separate words if appropriate
     *  wordCount: The number of words in the string
     *  confidence: The confidence of the word being correct, used for sorting
     *  isFront: Whether the word is from the front or back of the card
     *  isNumber: Whether the word is a number
     *  lowerCase: The word in lower case
     */
    let searchParagraphs: SearchableData[] = [];
    const addLabelsToSearch = (
      labelAnnotations: protos.google.cloud.vision.v1.IEntityAnnotation[] | undefined | null,
      isFront: boolean,
    ) => {
      if (labelAnnotations) {
        searchParagraphs.concat(
          labelAnnotations
            .filter((label) => label.description)
            .map((label: protos.google.cloud.vision.v1.IEntityAnnotation) => {
              const searchValue: Partial<SearchableData> = {
                word: label.description || '',
                words: label.description?.split(' ') || [],
                confidence: (isFront ? 102 : 101) + (label.score || 0),
                isFront,
              };
              searchValue.wordCount = searchValue.words?.length;
              searchValue.isNumber = searchValue.word ? !isNaN(Number(searchValue.word)) : false;
              searchValue.lowerCase = searchValue.word?.toLowerCase();
              return searchValue as SearchableData;
            }),
        );
      }
    };
    update(`Adding Labels for ${front}`);
    addLabelsToSearch(frontResult.labelAnnotations, true);
    update(`Adding Labels for ${back}`);
    addLabelsToSearch(backResult?.labelAnnotations, false);

    const addLogosToSearch = (
      logoAnnotations: protos.google.cloud.vision.v1.IEntityAnnotation[] | undefined | null,
      isFront: boolean,
    ) => {
      if (logoAnnotations) {
        searchParagraphs.concat(
          logoAnnotations
            .filter((label) => label.description)
            .map((logo: protos.google.cloud.vision.v1.IEntityAnnotation) => {
              const searchValue: Partial<SearchableData> = {
                word: logo.description || '',
                words: logo.description?.split(' ') || [],
                confidence: (isFront ? 602 : 601) + (logo.score || 0),
                isFront,
              };
              searchValue.wordCount = searchValue.words?.length;
              searchValue.isNumber = searchValue.word ? !isNaN(Number(searchValue.word)) : false;
              searchValue.lowerCase = searchValue.word?.toLowerCase();
              return searchValue as SearchableData;
            }),
        );
      }
    };
    update(`Adding Logos for ${front}`);
    addLogosToSearch(frontResult.logoAnnotations, true);
    update(`Adding Logos for ${back}`);
    addLogosToSearch(backResult?.logoAnnotations, false);

    const addSearch = async (
      textResult: protos.google.cloud.vision.v1.IAnnotateImageResponse,
      isFront: boolean = true,
    ) => {
      if (textResult) {
        const textBlocks: protos.google.cloud.vision.v1.IBlock[] =
          textResult.fullTextAnnotation?.pages?.[0]?.blocks?.filter((block) => block.blockType === 'TEXT') || [];
        const blocks: SearchableData[] = [];
        for (const block of textBlocks) {
          if (block.paragraphs) {
            for (const paragraph of block.paragraphs) {
              const searchValue: Partial<SearchableData> = {
                word: paragraph.words
                  ?.map((word: protos.google.cloud.vision.v1.IWord) =>
                    word.symbols?.map((symbol: protos.google.cloud.vision.v1.ISymbol) => symbol.text).join(''),
                  )
                  .join(' '),
                words:
                  paragraph.words?.map(
                    (word: protos.google.cloud.vision.v1.IWord) =>
                      word.symbols
                        ?.map((symbol: protos.google.cloud.vision.v1.ISymbol): string => symbol.text || '')
                        .join('') || '',
                  ) || [],
                wordCount: paragraph.words?.length || 0,
                confidence: (isFront ? 302 : 301) + (block.confidence || 0),
                isFront,
              };
              searchValue.isNumber = searchValue.word ? !isNaN(Number(searchValue.word)) : false;
              searchValue.lowerCase = searchValue.word?.toLowerCase();
              blocks.push(searchValue as SearchableData);
            }
          }
        }
        searchParagraphs = searchParagraphs.concat(blocks);
      }
    };
    update('Adding the full text of the card to the searchable data');
    if (backResult) {
      await Promise.all([addSearch(frontResult, true), addSearch(backResult, false)]);
    } else {
      await addSearch(frontResult, true);
    }

    defaults = await extractData(searchParagraphs, defaults, setData.metadata || [], update);

    finish(`Image Recognition ${front} converted to ${JSON.stringify(defaults)}`);
  } catch (e) {
    error(e);
  }
  return defaults;
}

export const extractData = async (
  searchParagraphs: SearchableData[],
  defaults: Partial<ImageRecognitionResults>,
  setData: Metadata,
  update: (msg: string) => void,
) => {
  let result = { ...defaults };
  update('Sorting Searchable Data');
  searchParagraphs = searchParagraphs.sort((a, b) => b.confidence - a.confidence);

  update('Checking for Panini Match');
  result = {
    ...result,
    ...(await paniniMatch(searchParagraphs, setData)),
  };

  update('Running NLP');
  result = {
    ...result,
    ...(await runNLP(searchParagraphs, setData, update)),
  };

  update('First pass only check for near exact matches');
  result = await runFirstPass(searchParagraphs, result, setData);

  update('Second pass, lets check things that are a little less exact');
  result = await runSecondPass(searchParagraphs, result, setData);

  update('Third pass, lets get really fuzzy');
  result = await fuzzyMatch(searchParagraphs, result);

  update('Clean Up data');
  if (result.cardNumber) {
    result.cardNumber = result.cardNumber.replaceAll(' ', '');
  }

  return result;
};

const getCropHints = async (client: ImageAnnotatorClient, image: string): Promise<CropHints | undefined> => {
  const [cropHintResults] = await client.cropHints(image);
  const hint = cropHintResults.cropHintsAnnotation?.cropHints?.[0].boundingPoly?.vertices;

  if (hint) {
    const left: number | null | undefined = hint.map((h) => h.x).sort((a, b) => a || 0 - (b || 0))[0];
    const top: number | null | undefined = hint.map((h) => h.y).sort((a, b) => a || 0 - (b || 0))[0];
    const right: number | null | undefined = hint.map((h) => h.x).sort((a, b) => b || 0 - (a || 0))[0];
    const bottom: number | null | undefined = hint.map((h) => h.y).sort((a, b) => b || 0 - (a || 0))[0];
    if (left && right && top && bottom) {
      return { left, top, width: right - left, height: bottom - top };
    }
  }
};

export const callNLP = async (text: string) => {
  return await hf.tokenClassification({
    model: 'dslim/bert-base-NER-uncased',
    inputs: text,
  });
};
export const runNLP = async (text: SearchableData[], setData: Metadata, update: UpdateSpinner) => {
  const brands = await getBrands();
  const inserts = await getInserts();
  const sets = await getSets();
  if (setData.player) {
    update('Skipping NLP because player is already set');
    return { player: setData.player };
  } else {
    update('Searching for a player name');
    const countWords = (word: string): number => {
      if (word) {
        const search = word.toLowerCase();
        return text.reduce((count, paragraph) => count + (paragraph.lowerCase?.includes(search) ? 1 : 0), 0);
      } else {
        return 0;
      }
    };
    const wordCount = (name: string) => name.split(' ').length;
    const results: Partial<ImageRecognitionResults> = {};
    const textBlock = text.map((block) => block.word).join('. ');
    update('Calling NLP engine');
    const segments = await callNLP(textBlock);
    update('Filtering results for PER type');
    const persons = segments.filter((segment) => segment.entity_group === 'PER');
    update(`Found ${persons.length} PER type results`);

    if (persons.length === 1) {
      results.player = titleCase(persons[0].word);
      update(`Found player ${results.player}`);
    } else if (persons.length > 1) {
      update(`Found ${persons.length} PER type results, filtering for names`);
      const names = persons
        //replace # with wildcard regex search for letters only of the text input
        .map((person) => {
          let finalWord;
          try {
            if (person.word.includes('#') && !person.word.includes('/')) {
              const rawWord = text.find((word) => word?.lowerCase?.match(person?.word?.replace(/#/g, "[A-Za-z.']+")));
              if (rawWord) {
                const end = person.word.replace(/#/g, '');
                finalWord =
                  rawWord && rawWord.word && rawWord.lowerCase
                    ? rawWord.word.slice(0, rawWord.lowerCase.indexOf(end) + end.length)
                    : undefined;
              }
            }
          } catch (e) {
            console.error(`Failed to process ${person} for wild card regexes`);
          }
          return { ...person, word: finalWord || person.word };
        })
        //remove any words that have a non-alphabetic character, also all spaces, periods and hyphens
        .filter((person) => person.word.match(/^[A-Za-z\s.\-']+$/))
        //names cannot start with a number or a symbol
        .filter((person) => !person.word.match(/^[^A-Za-z]/))
        //remove duplicates
        .filter((person, index, self) => index === self.findIndex((p) => p.word === person.word))
        //remove any names that are in the ignore list
        .filter(
          (person) => !brands.includes(person.word) && !inserts.includes(person.word) && !sets.includes(person.word),
        )
        //remove any names that are substrings of other names
        .filter((person) => !persons.find((search) => search.word !== person.word && search.word.includes(person.word)))
        //count the number of times that a name appears in the text
        .map((name) => ({
          ...name,
          count: name.word.split(/\s/).reduce((count, word) => count + countWords(word), 0),
          wordCount: wordCount(name.word),
        }))
        //sort first by count and then by score
        .sort((a, b) => {
          if (b.wordCount === 2 && a.wordCount !== 2) {
            return 1;
          } else if (a.wordCount === 2 && b.wordCount !== 2) {
            return -1;
          } else {
            return b.count - a.count || b.score - a.score;
          }
        })
        //remove all the excess info
        .map((person) => person.word)
        //remove any team names
        .filter((name) => !isTeam(name));

      update(`Checking ${names.length} names for a match`);
      if (names[0]?.includes(' ')) {
        results.player = titleCase(names[0]);
      } else if (names[1]?.includes(' ')) {
        results.player = titleCase(names[0]);
      } else if (names.length === 3) {
        const firstInitial = names.find((name) => name.length === 1);
        const secondInitial = names.find((name) => name.length === 1 && name !== firstInitial);
        const lastName = names.find((name) => name.length > 1);

        if (countWords(`${firstInitial}${secondInitial} ${lastName}`) > 0) {
          results.player = titleCase(`${firstInitial}${secondInitial} ${lastName}`);
        } else if (countWords(`${firstInitial}.${secondInitial}. ${lastName}`) > 0) {
          results.player = titleCase(`${firstInitial}.${secondInitial}. ${lastName}`);
        } else if (countWords(`${firstInitial}. ${secondInitial}. ${lastName}`) > 0) {
          results.player = titleCase(`${firstInitial}. ${secondInitial}. ${lastName}`);
        } else {
          results.player = titleCase(`${firstInitial} ${secondInitial} ${lastName}`);
        }
      } else {
        //check to see if any of our options are exact 2 words that both have letters in them
        const twoWords = names.filter((name) => {
          const split = name.split(' ');
          return split.length === 2 && split[0].match(/[A-Za-z]/) && split[1].match(/[A-Za-z]/);
        });

        if (twoWords.length === 1) {
          results.player = titleCase(twoWords[0]);
        } else {
          results.player = titleCase(`${names[0]} ${names[1]}`);
        }
      }
    }
    update(`Found player ${results.player}`);

    return results;
  }
};

const runFirstPass = async (
  searchParagraphs: SearchableData[],
  defaults: Partial<ImageRecognitionResults>,
  setData: Metadata,
) => {
  const brands = await getBrands();
  const inserts = await getInserts();
  const sets = await getSets();
  const results = { ...defaults };
  searchParagraphs.forEach((block: SearchableData) => {
    const wordCountBetween = (min: number, max: number): boolean => block.wordCount >= min && block.wordCount <= max;

    // console.log('First Pass: ', block)

    if (block.isNumber) {
      //do nothing in the first pass
    } else {
      if (!results.year) {
        const regexMatch = copyRightYearRegexMatch(block.word);
        if (regexMatch) {
          results.year = regexMatch;
        }
      }

      //look for Philadelphia copyright info
      const brandMatch = block.lowerCase?.replace(/\s|[.]/g, '');
      if (brandMatch && brandMatch.indexOf('pcg') > -1) {
        results.brand = 'Philadelphia Gum';
        results.setName = 'Philadelphia';
        block.set = true;
      }

      //look for Topps copyright info
      if (brandMatch && brandMatch.indexOf('tcg') > -1) {
        results.brand = 'Topps';
        results.setName = 'Topps';
        block.set = true;
      }

      if (setData.card_number_prefix && !results.cardNumber) {
        // concat all but the last value in the block.words array together
        const prefix = block.words
          .slice(0, -1)
          .map((word) => word.toLowerCase())
          .join('');
        if (prefix === setData.card_number_prefix.toLowerCase()) {
          results.cardNumber = block.words[block.words.length - 1];
          block.set = true;
        }
      }

      //block.set default.printRun if block.word matches a regex that is number then / then number
      if (!results.printRun && block.word?.match(/^\d+\/\d+$/)) {
        results.printRun = block.word.slice(block.word.indexOf('/') + 1);
        block.set = true;
      }
      //block.set default.printRun if block.word matches a regex that is number then of then number
      if (!results.printRun && block.word?.match(/^\d+ of \d+$/)) {
        results.printRun = block.word.slice(block.word.indexOf('of') + 3);
        block.set = true;
      }

      if (!results.cardNumber) {
        const firstWord = block.words[0].toLowerCase();
        if (wordCountBetween(2, 4) && ['no', 'no.'].includes(firstWord)) {
          results.cardNumber = block.words.slice(block.words.findIndex((word) => word.indexOf('.') >= 0) + 1).join('');
          block.set = true;
        }
      }

      if (!results.setName && wordCountBetween(1, 2) && block.lowerCase && sets.includes(block.lowerCase)) {
        results.setName = titleCase(block.word);
        block.set = true;
      } else if (!results.brand && wordCountBetween(1, 2) && block.lowerCase && brands.includes(block.lowerCase)) {
        results.brand = titleCase(block.word);
        block.set = true;
      }

      if (!results.insert && wordCountBetween(1, 2) && block.lowerCase && inserts.includes(block.lowerCase)) {
        results.insert = titleCase(block.word);
        block.set = true;
      }

      if (block.word === 'RC') {
        results.features = addFeature(results.features, 'RC');
      }

      if (block.word === '1st Bowman') {
        results.features = addFeature(results.features, 'FBC');
      }

      let teamTest: { display: string; sport: string } | undefined;
      if (!results.team) {
        block.words.find((word) => {
          teamTest = isTeam(word, setData.sport);
          if (teamTest && teamTest.display === 'USA MLB') {
            return false;
          }
          return teamTest;
        });

        if (teamTest) {
          results.team = teamTest.display;
          block.set = true;
          if (!results.sport) {
            results.sport = teamTest.sport;
          }
        }
      }
    }
  });
  return results;
};

const runSecondPass = async (
  searchParagraphs: SearchableData[],
  defaults: Partial<ImageRecognitionResults>,
  setData: Metadata,
) => {
  const results = { ...defaults };
  searchParagraphs
    .filter((block) => !block.set)
    .forEach((block) => {
      const wordCountBetween = (min: number, max: number) => block.wordCount >= min && block.wordCount <= max;

      // console.log('second pass: ', block)

      if (block.isNumber) {
        if (!results.year && block.word && parseInt(block.word) > 1900 && parseInt(block.word) < 2100) {
          //convert block.word to a number and add 1
          results.year = `${Number(block.word) + 1}`;
        } else if (!results.cardNumber && !setData.card_number_prefix && !block.isFront) {
          results.cardNumber = block.word;
        }
      }

      if (!results.cardNumber) {
        //set cardNumber if the block.word matches a regex that is letters followed by numbers with an optional space between
        if (block.word?.match(/^[a-zA-Z]{1,3}\s?-?\s?\d{1,3}/)) {
          results.cardNumber = block.word;
        }
      }

      if (!results.player && !block.set && block.isProperName && wordCountBetween(2, 3)) {
        results.player = titleCase(block.word);
      }
    });
  return results;
};

const yearRegex = /©\s?\d{4}/;
export const copyRightYearRegexMatch = (text: string) => {
  const yearMatch = text.match(yearRegex);
  if (yearMatch) {
    return yearMatch[0].slice(-4);
  }
};

const fuzzyMatch = async (
  searchParagraphs: SearchableData[],
  defaults: Partial<ImageRecognitionResults>,
): Promise<Partial<ImageRecognitionResults>> => {
  const results = { ...defaults };
  searchParagraphs
    .filter((block) => !block.set)
    .forEach((block) => {
      // console.log('third pass: ', block)

      if (!results.cardNumber && block.isNumber) {
        results.cardNumber = block.word;
        block.set = true;
      }

      if (!results.player && block.isProperName) {
        results.player = titleCase(block.word);
      }
    });
  return results;
};

const addFeature = (features: string[] | undefined, feature: string): string[] => {
  if (!features) {
    return [feature];
  } else if (!features.includes(feature)) {
    return [...features, feature];
  }
  return features;
};

export const paniniMatch = async (
  searchParagraphs: SearchableData[],
  defaults: Partial<ImageRecognitionResults>,
): Promise<Partial<ImageRecognitionResults>> => {
  if (defaults.brand && defaults.year && defaults.setName && defaults.insert) {
    return {};
  }
  const sets = await getSets();

  const results: Partial<ImageRecognitionResults> = {};
  const match = searchParagraphs.find((block) => block.lowerCase.match(/^\d\d\d\d panini - /));
  if (match) {
    results.brand = defaults.brand || 'Panini';
    results.year = defaults.year || match.words[0];
    results.setName = defaults.setName || titleCase(match.words[3]);
    const updateInsert = !defaults.insert;
    let i = 4;
    while (match.words[i] && !match.words[i].startsWith('Ⓒ') && !sports.includes(match.words[i].toLowerCase())) {
      if (match.words[i].toLowerCase() === 'draft' && match.words[i + 1]?.toLowerCase() === 'picks') {
        results.setName = `${results.setName} Draft Picks`;
        i++;
      } else if (
        updateInsert &&
        results.setName.toLowerCase() !== match.words[i].toLowerCase() &&
        !sets.includes(match.words[i].toLowerCase())
      ) {
        const nextWord = titleCase(match.words[i]);
        if (results.insert) {
          results.insert += ` ${nextWord}`;
        } else {
          results.insert = nextWord;
        }
      }
      i++;
    }
    if (!results.sport && sports.includes(match.words[i]?.toLowerCase())) {
      results.sport = match.words[i]?.toLowerCase();
    }
  }
  return results;
};

export default getTextFromImage;
