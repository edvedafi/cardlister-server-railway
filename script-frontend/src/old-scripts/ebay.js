//write a function that takes in a file path and an array of objects that will be written as a csv to the file
import { isNo, isYes } from '../utils/data.js';
import { gradeIds, graderIds } from './ebayConstants.js';
import open from 'open';
import eBayApi from 'ebay-api';
import chalk from 'chalk';
import express from 'express';
import fs from 'fs-extra';
import { useSpinners } from '../utils/spinners.js';

const { showSpinner, log } = useSpinners('ebay', '#84AF29');

const defaultValues = {
  action: 'Add',
  category: '261328',
  storeCategory: '10796387017',

  // Ebay Condition guide: https://developer.ebay.com/devzone/merchant-products/mipng/user-guide-en/content/condition-descriptor-ids-for-trading-cards.html
  // ungraded
  condition: '4000',

  //graded
  //condition: "3000",
  // conditionDetail: "40001",
  graded: 'No',
  grade: 'Not Graded',
  grader: 'Not Graded',
  parallel: 'Base',
  features: 'Base',
  team: 'N/A',
  autographed: 'No',
  // certNumber: "Not Graded",
  cardType: 'Sports Trading Card',
  autoAuth: 'N/A',
  signedBy: 'N/A',
  country: 'United States',
  original: 'Original',
  language: 'English',
  shippingInfo:
    'All shipping is with quality (though often used) top loaders, securely packaged and protected in an envelope if you choose the low cost Ebay Standard Envelope option. If you would like true tracking and a bubble mailer for further protection please choose the First Class Mail option. Please know your card will be packaged equally securely in both options!',
  format: 'FixedPrice',
  duration: 'GTC',
  shippingFrom: 'Green Bay, WI',
  shippingZip: '54311',
  shippingTime: '1',
  returns: 'ReturnsAccepted',
  returnPolicy: '30DaysMoneyBack',
  shippingPolicy: 'PWE_or_BMWT',
  acceptOffers: 'TRUE',
  weightUnit: 'LB',
  packageType: 'Letter',
};

const scopes = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  // 'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.email.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.phone.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.address.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.name.readonly',
  // 'https://api.ebay.com/oauth/api_scope/commerce.identity.status.readonly',
  // 'https://api.ebay.com/oauth/api_scope/sell.finances',
  // 'https://api.ebay.com/oauth/api_scope/sell.item.draft',
  ////////////'https://api.ebay.com/oauth/api_scope/sell.item',
  // 'https://api.ebay.com/oauth/api_scope/sell.reputation',
];
const refreshFile = '.ebay';
const getRefreshToken = async () => {
  try {
    if (fs.existsSync(refreshFile)) {
      return fs.readJSON(refreshFile);
    }
  } catch (e) {
    // eslint-disable-next-line no-undef
    console.error('Reading Refresh Token Failed');
    // eslint-disable-next-line no-undef
    console.error(e);
  }
};

const writeRefreshToken = async (refreshToken) => {
  try {
    await fs.writeJSON(refreshFile, refreshToken);
  } catch (e) {
    // eslint-disable-next-line no-undef
    console.error('Writing Refresh Token Failed');
    // eslint-disable-next-line no-undef
    console.error(e);
  }
};

export const loginEbayAPI = async () => {
  const eBay = eBayApi.fromEnv();

  eBay.OAuth2.setScope(scopes);

  let token = await getRefreshToken();
  if (!token) {
    const app = express();

    let resolve;
    const authCode = new Promise((_resolve) => {
      resolve = _resolve;
    });
    app.get('/oauth', function (req, res) {
      resolve(req.query.code);
      res.end('');
    });
    const server = app.listen(3000);

    // console.log(eBay.OAuth2.generateAuthUrl());
    await open(eBay.OAuth2.generateAuthUrl());
    const code = await authCode;
    // console.log('code', code);

    try {
      token = await eBay.OAuth2.getToken(code);
      await writeRefreshToken(token);
    } catch (e) {
      // eslint-disable-next-line no-undef
      console.error(e);
      throw e;
    } finally {
      server.close();
    }
  }

  eBay.OAuth2.setCredentials(token);

  // console.log('Logged in successfully!');
  return eBay;
};

export const getFeatures = (card) => {
  let features = card.features?.split('|');
  if (!features || (features.length === 1 && isNo(features[0])) || features[0] === '') {
    features = [];
  }

  if (card.parallel && !isNo(card.parallel)) {
    features.push('Parallel/Variety');
    if (card.parallel.toLowerCase().indexOf('refractor') > -1) {
      features.push('Refractor');
    }
  }

  if (card.insert && !isNo(card.insert)) {
    features.push('Insert');
  }

  if (card.printRun && card.printRun > 0) {
    features.push('Serial Numbered');
  }

  if (card.features?.indexOf('RC') > -1) {
    features.push('Rookie');
  }

  if (features.length === 0) {
    features.push('Base Set');
  }

  return features;
};

const booleanText = (val) => [isYes(val) ? 'Yes' : 'No'];
const displayOrNA = (testValue, displayValue) => {
  if (Array.isArray(displayValue) && displayValue.length > 0) {
    return displayValue;
  } else {
    return [testValue && !isNo(testValue) ? displayValue || testValue : 'N/A'];
  }
};
export const convertCardToInventory = (card) => ({
  availability: {
    // pickupAtLocationAvailability: [
    //   {
    //     availabilityType: 'IN_STOCK',
    //     fulfillmentTime: {
    //       unit: 'BUSINESS_DAY',
    //       value: '1',
    //     },
    //     merchantLocationKey: 'CardLister',
    //     quantity: card.quantity,
    //   },
    // ],
    shipToLocationAvailability: {
      availabilityDistributions: [
        {
          fulfillmentTime: {
            unit: 'BUSINESS_DAY', //'TimeDurationUnitEnum : [YEAR,MONTH,DAY,HOUR,CALENDAR_DAY,BUSINESS_DAY,MINUTE,SECOND,MILLISECOND]',
            value: '1',
          },
          merchantLocationKey: 'default',
          quantity: '1',
        },
      ],
      quantity: card.quantity,
    },
  },
  country: 'US',
  condition: isYes(card.graded) ? 'LIKE_NEW' : 'USED_VERY_GOOD', // could be "2750 :4000" instead?
  //'ConditionEnum : [NEW,LIKE_NEW,NEW_OTHER,NEW_WITH_DEFECTS,MANUFACTURER_REFURBISHED,CERTIFIED_REFURBISHED,EXCELLENT_REFURBISHED,VERY_GOOD_REFURBISHED,GOOD_REFURBISHED,SELLER_REFURBISHED,USED_EXCELLENT,USED_VERY_GOOD,USED_GOOD,USED_ACCEPTABLE,FOR_PARTS_OR_NOT_WORKING]',
  // conditionDescription: 'string',
  // need to support graded as well, this is only ungraded
  conditionDescriptors: isYes(card.graded)
    ? [
        {
          name: '27501',
          values: [graderIds[card.grader] || 2750123],
        },
        {
          name: '27502',
          values: [gradeIds[card.grade]],
        },
        {
          name: '27503',
          values: [card.certNumber],
        },
      ]
    : [
        {
          name: '40001',
          values: ['400011'],
        },
      ],
  packageWeightAndSize: {
    dimensions: {
      height: card.height,
      length: card.length,
      unit: 'INCH',
      width: card.width,
    },
    packageType: 'LETTER',
    // 'PackageTypeEnum : [LETTER,BULKY_GOODS,CARAVAN,CARS,EUROPALLET,EXPANDABLE_TOUGH_BAGS,EXTRA_LARGE_PACK,FURNITURE,INDUSTRY_VEHICLES,LARGE_CANADA_POSTBOX,LARGE_CANADA_POST_BUBBLE_MAILER,LARGE_ENVELOPE,MAILING_BOX,MEDIUM_CANADA_POST_BOX,MEDIUM_CANADA_POST_BUBBLE_MAILER,MOTORBIKES,ONE_WAY_PALLET,PACKAGE_THICK_ENVELOPE,PADDED_BAGS,PARCEL_OR_PADDED_ENVELOPE,ROLL,SMALL_CANADA_POST_BOX,SMALL_CANADA_POST_BUBBLE_MAILER,TOUGH_BAGS,UPS_LETTER,USPS_FLAT_RATE_ENVELOPE,USPS_LARGE_PACK,VERY_LARGE_PACK,WINE_PAK]',
    weight: {
      unit: 'OUNCE',
      value: card.oz,
    },
  },
  product: {
    aspects: {
      'Country/Region of Manufacture': ['United States'],
      country: ['United States'],
      type: ['Sports Trading Card'],
      sport: displayOrNA(card.sport, card.sport?.slice(0, 1).toUpperCase() + card.sport?.slice(1).toLowerCase()),
      Franchise: displayOrNA(
        card.team?.length > 0,
        card.team?.map((team) => team.display),
      ),
      team: displayOrNA(
        card.team?.length > 0,
        card.team?.map((team) => team.display),
      ),
      league: displayOrNA(
        {
          mlb: 'Major League (MLB)',
          nfl: 'National Football League (NFL)',
          nba: 'National Basketball Association (NBA)',
          nhl: 'National Hockey League (NHL)',
        }[card.league?.toLowerCase()] || card.league,
      ),
      Set: [`${card.year} ${card.setName}`],
      Manufacturer: [card.manufacture],
      'Year Manufactured': [card.year.indexOf('-') > -1 ? card.year.split('-')[0] : card.year],
      Season: [card.year.indexOf('-') > -1 ? card.year.split('-')[0] : card.year],
      Character: [card.player],
      'Player/Athlete': [card.player],
      'Autograph Authentication': displayOrNA(card.autographed, card.manufacture),
      Grade: displayOrNA(card.grade),
      Graded: booleanText(card.graded),
      'Autograph Format': displayOrNA(card.autoFormat),
      'Professional Grader': displayOrNA(card.grader),
      'Certification Number': displayOrNA(card.certNumber),
      'Autograph Authentication Number': displayOrNA(card.certNumber),
      Features: getFeatures(card),
      'Parallel/Variety': [card.parallel || (card.insert && !isNo(card.insert) ? 'Base Insert' : 'Base Set')],
      Autographed: booleanText(card.autographed),
      'Card Name': [card.cardName],
      'Card Number': [card.cardNumber],
      'Signed By': displayOrNA(card.autographed, card.player),
      Material: [card.material],
      'Card Size': [card.size],
      'Card Thickness': [card.thickness.indexOf('pt') < 0 ? `${card.thickness} Pt.` : card.thickness],
      Language: [card.language || 'English'],
      'Original/Licensed Reprint': [card.original || 'Original'],
      Vintage: booleanText(parseInt(card.year) < 1986),
      'Card Condition': [card.condition || 'Excellent'],
      'Convention/Event': displayOrNA(card.convention),
      'Insert Set': [card.insert || 'Base Set'],
      'Print Run': displayOrNA(card.printRun),
    },
    country: 'United States',
    brand: card.manufacture,
    description: card.description || `${card.longTitle}<br><br>${defaultValues.shippingInfo}`,
    // ean: ['string'],
    // epid: 'string',
    imageUrls: card.pics,
    // isbn: ['string'],
    mpn: card.setName,
    // subtitle: 'string',
    title: card.title,
    // upc: ['string'],
    // videoIds: ['string'],
  },
});

let cachedLocation;
export const getLocation = async (eBay) => {
  const { update, finish } = showSpinner('location', 'Getting Location');
  if (cachedLocation) {
    finish();
    return cachedLocation;
  } else {
    let location;
    try {
      location = await eBay.sell.inventory.getInventoryLocation('CardLister');
    } catch (e) {
      update('No Location Found, Creating');
      if (e.meta?.errorId === 25804) {
        location = await eBay.sell.inventory.createInventoryLocation('CardLister', {
          location: {
            address: {
              addressLine1: '3458 Edinburgh Rd',
              // addressLine2: 'string',
              city: 'Green Bay',
              country: 'US',
              // 'CountryCodeEnum : [AD,AE,AF,AG,AI,AL,AM,AN,AO,AQ,AR,AS,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BV,BW,BY,BZ,CA,CC,CD,CF,CG,CH,CI,CK,CL,CM,CN,CO,CR,CU,CV,CW,CX,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,FM,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GS,GT,GU,GW,GY,HK,HM,HN,HR,HT,HU,ID,IE,IL,IM,IN,IO,IQ,IR,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,KP,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MH,MK,ML,MM,MN,MO,MP,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NF,NG,NI,NL,NO,NP,NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PW,PY,QA,RE,RO,RS,RU,RW,SA,SB,SC,SD,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,ST,SV,SX,SY,SZ,TC,TD,TF,TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,UM,US,UY,UZ,VA,VC,VE,VG,VI,VN,VU,WF,WS,YE,YT,ZA,ZM,ZW]',
              // county: 'string',
              postalCode: '54311',
              stateOrProvince: 'WI',
            },
            // geoCoordinates: {
            //   latitude: 'number',
            //   longitude: 'number',
            // },
          },
          // locationAdditionalInformation: 'string',
          // locationInstructions: 'string',
          // locationTypes: ['StoreTypeEnum'],
          locationWebUrl: 'www.edvedafi.com',
          merchantLocationStatus: 'ENABLED', //'StatusEnum : [DISABLED,ENABLED]',
          name: 'CardLister',
          // operatingHours: [
          //   {
          //     dayOfWeekEnum: 'DayOfWeekEnum : [MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY,SUNDAY]',
          //     intervals: [
          //       {
          //         close: 'string',
          //         open: 'string',
          //       },
          //     ],
          //   },
          // ],
          // phone: 'string',
          // specialHours: [
          //   {
          //     date: 'string',
          //     intervals: [
          //       {
          //         close: 'string',
          //         open: 'string',
          //       },
          //     ],
          //   },
          // ],
        });
      }
      showSpinner('location', 'Created new location');
      location = await eBay.sell.inventory.getInventoryLocation('CardLister');
    }
    cachedLocation = location;
    finish();
    return location;
  }
};
export const removeFromEbayItemNumber = async (itemNumber, quantity, title) => {
  const { update, error, finish } = showSpinner(`ebay-card-${itemNumber}-details`, `Removing ${itemNumber}`);
  update('Login');
  const result = { title, quantity, removed: false };
  const ebay = await loginEbayAPI();
  try {
    update('Getting Item Details');
    let item;
    item = await ebay.trading.GetItem({ ItemID: itemNumber });
    log(
      `${parseInt(item.Item.Quantity)} - ${parseInt(quantity)} = ${parseInt(item.Item.Quantity) - parseInt(quantity)}`,
    );
    const updatedQuantity = parseInt(item.Item.Quantity) - parseInt(quantity);
    result.updatedQuantity = updatedQuantity;
    if (updatedQuantity <= 0) {
      try {
        update('Ending the Item');
        await ebay.trading.EndFixedPriceItem({ ItemID: itemNumber, EndingReason: 'NotAvailable' });
        result.removed = true;
      } catch (e) {
        if (e.meta?.Errors?.ErrorCode === 1047) {
          finish();
          result.removed = true;
        } else {
          result.removed = false;
          error(e, e.meta?.Errors?.ErrorCode || e.message);
          result.error = e.meta?.Errors?.ErrorCode || e.message;
        }
      }
    } else {
      try {
        update(`Setting quantity to ${updatedQuantity}`);
        await ebay.trading.ReviseInventoryStatus({
          InventoryStatus: {
            ItemID: itemNumber,
            Quantity: updatedQuantity,
          },
        });
        finish();
        result.removed = true;
      } catch (e) {
        log(`Failed to update quantity for ${title} to ${updatedQuantity}`);
        error(e, e.meta?.Errors?.ErrorCode || e.message);
        result.error = e.meta.Errors.ErrorCode;
      }
    }
  } catch (e) {
    if (e.meta?.Errors?.ErrorCode === 17) {
      update(`Item ${itemNumber} was already ended`);
      result.removed = true;
    } else {
      log(e.meta?.Errors?.ErrorCode || e.message, e);
      result.error = e.meta.Errors.ErrorCode;
    }
  }
  return result;
};

export const removeFromEbayBySKU = async (sku, quantity, title) => {
  const { update, finish } = showSpinner(`ebay-card-${sku}-details`, `Removing ${sku}`);
  update('login');
  const ebay = await loginEbayAPI();
  const result = { title, quantity, removed: false };
  try {
    update(`${sku}: Fetch all offers`);
    const offers = await ebay.sell.inventory.getOffers({ sku });
    const item = offers.offers[0];
    const updatedQuantity = parseInt(item.availableQuantity) - parseInt(quantity);
    result.updatedQuantity = updatedQuantity;
    if (updatedQuantity <= 0) {
      try {
        update(`No more inventory; end item`);
        await ebay.sell.inventory.deleteOffer(item.offerId);
        update(`Successfully Ended Item`);
        result.removed = true;
      } catch (e) {
        if (e.meta.Errors.ErrorCode === 1047) {
          update(`Item was already ended`);
          result.removed = true;
        } else {
          result.removed = false;
          result.error = e.meta?.Errors?.ErrorCode || e.message;
          update(`Failed to remove: ${e.meta?.Errors?.ErrorCode || e.message}`);
        }
      }
    } else {
      try {
        update(`Setting remaining quantity to ${updatedQuantity}`);
        await ebay.sell.inventory.updateOffer(item.offerId, { ...item, availableQuantity: updatedQuantity });
        update(`Successfully set remaining quantity to ${updatedQuantity}`);
        result.removed = true;
      } catch (e) {
        update(`Failed to reduce quantity ${e?.meta?.Errors?.ErrorCode || e?.message}`);
        // eslint-disable-next-line no-undef
        console.error(chalk.red(`Failed to reduce quantity of ${title} on ebay`));
        result.error = e?.meta?.Errors?.ErrorCode || e?.message;
      }
    }
  } catch (e) {
    update(`Failed to update ${e?.meta?.Errors?.ErrorCode || e?.message}`);
    result.error = e?.meta?.Errors?.ErrorCode || e?.message;
  }
  finish();
  return result;
};

export const removeFromEbay = async (cards = []) => {
  const processSpinner = showSpinner('ebay', 'Removing Cards from eBay');
  let toRemove = cards.filter((card) => !card.platform?.startsWith('ebay'));
  processSpinner.update(`Removing ${chalk.green(toRemove.length)} cards from eBay`);
  const removed = [];

  if (toRemove.length > 0) {
    processSpinner.update('Sorting Cards by SKU');
    const removals = [];
    for (const card of toRemove) {
      const cardSpinner = showSpinner(`ebay-card-${card.title}`, `${card.title}: Checking for Item Number or SKU`);
      if (card.ItemID) {
        cardSpinner.update(`Removing by Item Number`);
        removals.push(await removeFromEbayItemNumber(card.ItemID, card.quantity, card.title));
        cardSpinner.finish();
      } else if (card.sku) {
        cardSpinner.update(`Removing by SKU`);
        removals.push(await removeFromEbayBySKU(card.sku, card.quantity, card.title));
        cardSpinner.finish();
      } else {
        cardSpinner.error(
          `ebay-card-${card.title}`,
          `${card.title}: No Item Number or SKU ${card.quantity > 1 ? `(x${card.quantity})` : ''}`,
        );
      }
    }

    processSpinner.update('Running Removals');
    const results = await Promise.all(removals);
    results.forEach((result) => {
      if (result.removed) {
        removed.push(result);
      }
    });

    if (removed.length === toRemove.length && toRemove.length === 0) {
      processSpinner.finish(`Removed all ${chalk.green(removed.length)} cards from ebay`);
    } else {
      processSpinner.finish(`Removed ${chalk.red(removed.length)} of ${chalk.red(toRemove.length)} cards from ebay`);
    }
  } else {
    processSpinner.finish('No cards to remove from ebay');
  }
};
