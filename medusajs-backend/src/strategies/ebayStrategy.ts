import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import ListingStrategy from './ListingStrategy';
import eBayApi from 'ebay-api';
import process from 'node:process';
import { isNo, isYes, titleCase } from '../utils/data';
import { EbayOfferDetailsWithKeys, InventoryItem } from 'ebay-api/lib/types';
import fs from 'fs-extra';
import _ from 'lodash';

class EbayStrategy extends ListingStrategy<eBayApi> {
  static identifier = 'ebay-strategy';
  static batchType = 'ebay-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(api: eBayApi, category: ProductCategory): Promise<void> {
    //TODO Need to Implement
  }

  async getRefreshToken() {
    // TODO PROVIDE AN EBAY LOGIN SCREEN
    if (process.env.EBAY_TOKEN) {
      return JSON.parse(process.env.EBAY_TOKEN);
    } else {
      return fs.readJsonSync('.ebay');
    }
  }

  async login(): Promise<eBayApi> {
    const eBay = eBayApi.fromEnv();

    eBay.OAuth2.setScope([
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
    ]);

    const token = await this.getRefreshToken();
    if (!token) {
      throw new Error('No eBay Token Found');
    }

    eBay.OAuth2.setCredentials(token);

    return eBay;
  }

  async syncProducts(eBay: eBayApi, products: Product[], category: ProductCategory): Promise<number> {
    let count = 0;
    for (const product of products) {
      if (product.images.length > 0) {
        for (const variant of product.variants) {
          count += await this.syncProduct(eBay, product, variant, category);
        }
      }
    }
    return count;
  }

  async syncProduct(
    eBay: eBayApi,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
  ): Promise<number> {
    //only sync products with images
    if (product.images.length === 0) {
      return 0;
    }

    let offers: {
      offers?: {
        offerId: string;
        availableQuantity: number;
      }[];
    };
    try {
      offers = await eBay.sell.inventory.getOffers({ sku: variant.sku });
    } catch (e) {
      offers = undefined;
    }

    const quantity = await this.getQuantity({ variant });

    if (offers && offers.offers && offers.offers.length > 0) {
      const offer = offers.offers[0];
      if (quantity === offer.availableQuantity) {
        this.log(`No Updates needed for:: ${variant.sku}`);
        return 0;
      } else if (quantity === 0) {
        try {
          this.log(`Deleting offer for ${variant.sku}`);
          await eBay.sell.inventory.deleteOffer(offer.offerId);
          return 1;
        } catch (e) {
          //TODO Need to log this in a handleable way
          this.log(`deleteOffer::error ${e.meta?.Errors?.ErrorCode || e.message}`, e);
        }
        return 1;
      } else {
        this.log(`Updating quantity for ${variant.sku}`);
        await eBay.sell.inventory.updateOffer(offer.offerId, { ...offer, availableQuantity: quantity });
        return quantity;
      }
    } else if (quantity > 0) {
      this.log(`Creating new offer for ${variant.sku}`);
      const ebayInventoryItem: InventoryItem = convertCardToInventory(product, variant, category, quantity);
      await eBay.sell.inventory.createOrReplaceInventoryItem(variant.sku, ebayInventoryItem);
      const offer = createOfferForCard(product, variant, category, quantity, this.getPrice(variant));
      let offerId: string;
      try {
        const response = await eBay.sell.inventory.createOffer(offer);
        offerId = response.offerId;
      } catch (e) {
        const error = e.meta?.res?.data.errors[0];
        if (error?.errorId === 25002) {
          offerId = error.parameters[0].value;
          await eBay.sell.inventory.updateOffer(offerId, offer);
        }
      }
      await eBay.sell.inventory.publishOffer(offerId);
      return quantity;
    }
  }
}

function convertCardToInventory(
  card: Product,
  variant: ProductVariant,
  category: ProductCategory,
  quantity: number,
): InventoryItem {
  const inventoryItem: InventoryItem = {
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
              value: 1,
            },
            merchantLocationKey: 'default',
            quantity: 1,
          },
        ],
        quantity: quantity,
      },
    },
    condition: card.metadata.grade ? 'LIKE_NEW' : 'USED_VERY_GOOD', // could be "2750 :4000" instead?
    //'ConditionEnum : [NEW,LIKE_NEW,NEW_OTHER,NEW_WITH_DEFECTS,MANUFACTURER_REFURBISHED,CERTIFIED_REFURBISHED,EXCELLENT_REFURBISHED,VERY_GOOD_REFURBISHED,GOOD_REFURBISHED,SELLER_REFURBISHED,USED_EXCELLENT,USED_VERY_GOOD,USED_GOOD,USED_ACCEPTABLE,FOR_PARTS_OR_NOT_WORKING]',
    // conditionDescription: 'string',
    // need to support graded as well, this is only ungraded
    conditionDescriptors: card.metadata.grade
      ? [
          {
            name: '27501',
            values: [graderIds[card.metadata.grader as string] || 2750123],
          },
          {
            name: '27502',
            values: [gradeIds[card.metadata.grade as string]],
          },
          {
            name: '27503',
            values: [card.metadata.certNumber],
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
        value: card.weight,
      },
    },
    product: {
      title: card.title,
      // subtitle: 'string',
      brand: category.metadata.brand as string,
      description: `${card.description}
                  <br><br>
                   All shipping is with quality (though often used) top loaders, securely packaged and protected in an envelope if you choose the low-cost Ebay Standard Envelope option. If you would like true tracking and a bubble mailer for further protection please choose the First Class Mail option. Please know your card will be packaged equally securely in both options!`,
      // ean: ['string'],
      // epid: 'string',
      imageUrls: _.sortBy(card.images, 'url').map(
        (image) => `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${image.url}?alt=media`,
      ),
      // isbn: ['string'],
      mpn: category.metadata.setName as string,
      // upc: ['string'],
      // videoIds: ['string'],
    },
  };
  // @ts-expect-error Ebay's API is incorrectly typed for sports cards
  inventoryItem.product.country = 'United States';
  // @ts-expect-error Ebay's API is incorrectly typed for sports cards
  inventoryItem.country = 'US';
  // @ts-expect-error Ebay's API is incorrectly typed for sports cards
  inventoryItem.product.aspects = {
    'Country/Region of Manufacture': ['United States'],
    country: ['United States'],
    type: ['Sports Trading Card'],
    sport: displayOrNA(category.metadata.sport as string),
    Franchise: displayOrNA(card.metadata.teams),
    team: displayOrNA(card.metadata.teams),
    league: displayOrNA(
      {
        mlb: 'Major League (MLB)',
        MLB: 'Major League (MLB)',
        nfl: 'National Football League (NFL)',
        NFL: 'National Football League (NFL)',
        nba: 'National Basketball Association (NBA)',
        NBA: 'National Basketball Association (NBA)',
        nhl: 'National Hockey League (NHL)',
        NHL: 'National Hockey League (NHL)',
      }[category.metadata.league as string],
    ),
    Set: [`${category.metadata.year} ${category.metadata.setName}`],
    Manufacturer: [category.metadata.brand],
    'Year Manufactured': [displayYear(category.metadata.year as string)],
    Season: [displayYear(category.metadata.year as string)],
    Character: card.metadata.player,
    'Player/Athlete': card.metadata.player,
    'Autograph Authentication': displayOrNA(card.metadata.autographed, category.metadata.brand),
    Grade: displayOrNA(card.metadata.grade),
    Graded: booleanText(card.metadata.graded),
    'Autograph Format': displayOrNA(card.metadata.autoFormat),
    'Professional Grader': displayOrNA(card.metadata.grader),
    'Certification Number': displayOrNA(card.metadata.certNumber),
    'Autograph Authentication Number': displayOrNA(card.metadata.certNumber),
    Features: getFeatures(card, category),
    'Parallel/Variety': [
      category.metadata.parallel ||
        (category.metadata.insert && !isNo(category.metadata.insert) ? 'Base Insert' : 'Base Set'),
    ],
    Autographed: booleanText(card.metadata.autographed),
    'Card Name': [variant.metadata?.cardName || card.metadata?.cardName],
    'Card Number': [card.metadata.cardNumber],
    'Signed By': displayOrNA(card.metadata.autographed, card.metadata.player),
    Material: [card.material],
    'Card Size': [card.metadata.size],
    'Card Thickness': getThickness(card.metadata.thickness as string),
    Language: [category.metadata.language || 'English'],
    'Original/Licensed Reprint': [category.metadata.original || 'Original'],
    Vintage: booleanText(parseInt(card.metadata.year as string) < 1986),
    'Card Condition': [card.metadata.condition || 'Excellent'],
    'Convention/Event': displayOrNA(card.metadata.convention),
    'Insert Set': [card.metadata.insert || 'Base Set'],
    'Print Run': displayOrNA(card.metadata.printRun),
  };
  return inventoryItem;
}

const createOfferForCard = (
  card: Product,
  variant: ProductVariant,
  category: ProductCategory,
  quantity: number,
  price: number,
): EbayOfferDetailsWithKeys => ({
  availableQuantity: quantity,
  categoryId: '261328',
  // "charity": {
  //   "charityId": "string",
  //   "donationPercentage": "string"
  // },
  // "extendedProducerResponsibility": {
  //   "ecoParticipationFee": {
  //     "currency": "string",
  //     "value": "string"
  //   },
  //   "producerProductId": "string",
  //   "productDocumentationId": "string",
  //   "productPackageId": "string",
  //   "shipmentPackageId": "string"
  // },
  format: 'FIXED_PRICE', //"FormatTypeEnum : [AUCTION,FIXED_PRICE]",
  hideBuyerDetails: true,
  // includeCatalogProductDetails: true,
  // listingDescription: 'string',
  listingDuration: 'GTC', //"ListingDurationEnum : [DAYS_1,DAYS_3,DAYS_5,DAYS_7,DAYS_10,DAYS_21,DAYS_30,GTC]",
  listingPolicies: {
    bestOfferTerms: {
      // autoAcceptPrice: {
      //   currency: 'USD',
      //   value: card.price,
      // },
      // autoDeclinePrice: {
      //   currency: 'string',
      //   value: 'string',
      // },
      bestOfferEnabled: true,
    },
    // eBayPlusIfEligible: 'boolean',
    fulfillmentPolicyId: '122729485024',
    paymentPolicyId: '173080971024',
    // productCompliancePolicyIds: ['string'],
    // regionalProductCompliancePolicies: {
    //   countryPolicies: [
    //     {
    //       country:
    //         'CountryCodeEnum : [AD,AE,AF,AG,AI,AL,AM,AN,AO,AQ,AR,AS,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BV,BW,BY,BZ,CA,CC,CD,CF,CG,CH,CI,CK,CL,CM,CN,CO,CR,CU,CV,CW,CX,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,FM,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GS,GT,GU,GW,GY,HK,HM,HN,HR,HT,HU,ID,IE,IL,IM,IN,IO,IQ,IR,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,KP,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MH,MK,ML,MM,MN,MO,MP,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NF,NG,NI,NL,NO,NP,NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PW,PY,QA,RE,RO,RS,RU,RW,SA,SB,SC,SD,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,ST,SV,SX,SY,SZ,TC,TD,TF,TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,UM,US,UY,UZ,VA,VC,VE,VG,VI,VN,VU,WF,WS,YE,YT,ZA,ZM,ZW]',
    //       policyIds: ['string'],
    //     },
    //   ],
    // },
    // regionalTakeBackPolicies: {
    //   countryPolicies: [
    //     {
    //       country:
    //         'CountryCodeEnum : [AD,AE,AF,AG,AI,AL,AM,AN,AO,AQ,AR,AS,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BV,BW,BY,BZ,CA,CC,CD,CF,CG,CH,CI,CK,CL,CM,CN,CO,CR,CU,CV,CW,CX,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,FM,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GS,GT,GU,GW,GY,HK,HM,HN,HR,HT,HU,ID,IE,IL,IM,IN,IO,IQ,IR,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,KP,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MH,MK,ML,MM,MN,MO,MP,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NF,NG,NI,NL,NO,NP,NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PW,PY,QA,RE,RO,RS,RU,RW,SA,SB,SC,SD,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,ST,SV,SX,SY,SZ,TC,TD,TF,TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,UM,US,UY,UZ,VA,VC,VE,VG,VI,VN,VU,WF,WS,YE,YT,ZA,ZM,ZW]',
    //       policyIds: ['string'],
    //     },
    //   ],
    // },
    returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
    // shippingCostOverrides: [
    //   {
    //     additionalShippingCost: {
    //       currency: 'string',
    //       value: 'string',
    //     },
    //     priority: 'integer',
    //     shippingCost: {
    //       currency: 'string',
    //       value: 'string',
    //     },
    //     shippingServiceType: 'ShippingServiceTypeEnum : [DOMESTIC,INTERNATIONAL]',
    //     surcharge: {
    //       currency: 'string',
    //       value: 'string',
    //     },
    //   },
    // ],
    // takeBackPolicyId: 'string',
  },
  // listingStartDate: 'string',
  // lotSize: 'integer',
  marketplaceId: 'EBAY_US',
  //'MarketplaceEnum : [EBAY_US,EBAY_MOTORS,EBAY_CA,EBAY_GB,EBAY_AU,EBAY_AT,EBAY_BE,EBAY_FR,EBAY_DE,EBAY_IT,EBAY_NL,EBAY_ES,EBAY_CH,EBAY_TW,EBAY_CZ,EBAY_DK,EBAY_FI,EBAY_GR,EBAY_HK,EBAY_HU,EBAY_IN,EBAY_ID,EBAY_IE,EBAY_IL,EBAY_MY,EBAY_NZ,EBAY_NO,EBAY_PH,EBAY_PL,EBAY_PT,EBAY_PR,EBAY_RU,EBAY_SG,EBAY_ZA,EBAY_SE,EBAY_TH,EBAY_VN,EBAY_CN,EBAY_PE,EBAY_JP]',
  merchantLocationKey: 'CardLister',
  pricingSummary: {
    // auctionReservePrice: {
    //   currency: 'string',
    //   value: 'string',
    // },
    // auctionStartPrice: {
    //   currency: 'string',
    //   value: 'string',
    // },
    // minimumAdvertisedPrice: {
    //   currency: 'string',
    //   value: 'string',
    // },
    // originallySoldForRetailPriceOn: 'SoldOnEnum : [ON_EBAY,OFF_EBAY,ON_AND_OFF_EBAY]',
    // originalRetailPrice: {
    //   currency: 'string',
    //   value: 'string',
    // },
    price: {
      currency: 'USD',
      value: `${price}`,
    },
    pricingVisibility: 'NONE', //'MinimumAdvertisedPriceHandlingEnum : [NONE,PRE_CHECKOUT,DURING_CHECKOUT]',
  },
  // quantityLimitPerBuyer: 'integer',
  // regulatory: {
  //   energyEfficiencyLabel: {
  //     imageDescription: 'string',
  //     imageURL: 'string',
  //     productInformationSheet: 'string',
  //   },
  //   hazmat: {
  //     component: 'string',
  //     pictograms: ['string'],
  //     signalWord: 'string',
  //     statements: ['string'],
  //   },
  //   repairScore: 'number',
  // },
  // secondaryCategoryId: 'string',
  sku: variant.sku,
  storeCategoryNames: [category.metadata.sport as string],
  // tax: {
  //   applyTax: 'boolean',
  //   thirdPartyTaxCategory: 'string',
  //   vatPercentage: 'number',
  // },
});

const booleanText = (val: string | boolean | unknown): [string] => [isYes(val) ? 'Yes' : 'No'];

const displayOrNA = (testValue: string | boolean | unknown, displayValue: unknown = testValue): [string] => {
  if (Array.isArray(displayValue) && displayValue.length > 0) {
    return displayValue.map(titleCase) as [string];
  } else {
    return [testValue && !isNo(testValue.toString()) ? titleCase(displayValue.toString()) : 'N/A'];
  }
};

export const displayYear = (year: string): string => (year.indexOf('-') > -1 ? year.split('-')[0] : year);

export const getThickness = (thickness: string): string[] => [
  thickness.toLowerCase().indexOf('pt') < 0 ? `${thickness} Pt.` : thickness,
];

export const getFeatures = (card: Product, category: ProductCategory) => {
  let features: string[] = (card.metadata.features as string[]) || [];
  if (!features || (features.length === 1 && isNo(features[0])) || features[0] === '') {
    features = [];
  }

  const parallel: string = category.metadata.parallel as string;
  if (parallel && !isNo(parallel)) {
    features.push('Parallel/Variety');
    if (parallel.toLowerCase().indexOf('refractor') > -1) {
      features.push('Refractor');
    }
  }

  if (category.metadata.insert && !isNo(category.metadata.insert)) {
    features.push('Insert');
  }

  if (card.metadata.printRun && (card.metadata.printRun as number) > 0) {
    features.push('Serial Numbered');
  }

  if (features.includes('RC')) {
    features.push('Rookie');
  }

  if (features.length === 0) {
    features.push('Base Set');
  }

  return features;
};

const gradeIds = {
  10: 275020,
  9.5: 275021,
  9: 275022,
  8.5: 275023,
  8: 275024,
  7.5: 275025,
  7: 275026,
  6.5: 275027,
  6: 275028,
  5.5: 275029,
  5: 2750210,
  4.5: 2750211,
  4: 2750212,
  3.5: 2750213,
  3: 2750214,
  2.5: 2750215,
  2: 2750216,
  1.5: 2750217,
  1: 2750218,
  Authentic: 2750219,
  'Authentic Altered': 2750220,
  'Authentic - Trimmed': 2750221,
  'Authentic - Coloured': 2750222,
};

const graderIds = {
  PSA: 275010,
  BCCG: 275011,
  BVG: 275012,
  BGS: 275013,
  CSG: 275014,
  CGC: 275015,
  SGC: 275016,
  KSA: 275017,
  GMA: 275018,
  HGA: 275019,
  ISA: 2750110,
  PCA: 2750111,
  GSG: 2750112,
  PGS: 2750113,
  MNT: 2750114,
  TAG: 2750115,
  Rare: 2750116,
  RCG: 2750117,
  PCG: 2750118,
  Ace: 2750119,
  CGA: 2750120,
  TCG: 2750121,
  ARK: 2750122,
};

export default EbayStrategy;
