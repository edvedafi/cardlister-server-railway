import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy, { ListAttempt } from './AbstractListingStrategy';
import eBayApi from 'ebay-api';
import process from 'node:process';
import { isNo, isYes, titleCase } from '../utils/data';
import { EbayOfferDetailsWithKeys, InventoryItem } from 'ebay-api/lib/types';
import { login as ebayLogin } from '../utils/ebayAPI';
import { EbayApiError } from 'ebay-api/lib/errors';

type Offer = {
  offerId: string;
  availableQuantity: number;
  status: 'PUBLISHED' | 'UNPUBLISHED';
};

function handleEbayError(e: Error, nonErrors: number[] = []): string | undefined {
  if ('meta' in e) {
    const err: EbayApiError = e as EbayApiError;
    if (nonErrors.includes(err.errorCode)) {
      return undefined;
    } else if ('message' in err.firstError && err.firstError.message) {
      return `${err.firstError.message}`;
    } else if (err.firstError) {
      return JSON.stringify(err.firstError);
    } else {
      return err.message;
    }
  }
return e.message;
}

class EbayListingStrategy extends AbstractListingStrategy<eBayApi> {
  static identifier = 'ebay-strategy';
  static batchType = 'ebay-sync';
  static listingSite = 'ebay';
  requireImages = true;

  async login(): Promise<eBayApi> {
    return ebayLogin();
  }

  async getOffers(eBay: eBayApi, sku: string): Promise<Offer[]> {
    const callEbay = (sku: string) => {
      return eBay.sell.inventory.getOffers({ sku }).catch(e => {
        if (handleEbayError(e, [25710, 25713])) throw e;
        return { offers: [] };
      }).then(res => res.offers);
    };
    try {
      const offers = [
        ...(await callEbay(sku)),
        ...(await callEbay(sku.replace('|', '_'))),
        ...(await callEbay(sku.replace('_', '|')))
        ];
        this.log(`Found ${offers.length} offers for ${sku} that have skus ${offers.map(o => o.sku).join(', ')}`);
        return offers;
      } catch (e) {
        const message = handleEbayError(e, [25710, 25713]);
        if (message) {
          this.log(message, e);
        } else {
          this.log(`Error getting offers for ${sku}:`, e);
        }
        return [];
      }
  }
  
  async removeProduct(eBay: eBayApi, product: Product, variant: ProductVariant): Promise<ListAttempt> {
    let error: ListAttempt | undefined;
    const hasError = (e: unknown) => {
      this.log(`Error removing offers for ${variant.sku}: ${e}`);
      const err = handleEbayError(<Error>e, [25710, 25713]);
      if (err) {
        error = { error: err };
      }
    };
    let offers: Offer[] = [];
    try {
      offers = await this.getOffers(eBay, variant.sku);
      this.log(`Removing ${offers.length} offers for ${variant.sku}`);
      for (let i = 0; i < offers.length; i++) {
        try {
          await eBay.sell.inventory.deleteOffer(offers[i].offerId);
        } catch (e) {
          hasError(e);
        }
      }
      await eBay.sell.inventory.deleteInventoryItem(variant.sku);
    } catch (e) {
      hasError(e);
    }
    return error || { quantity: offers.length };
  }

  async syncProduct(
    eBay: eBayApi,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    this.log(`Syncing product ${variant.sku}`);
    await this.ensureLocationExists(eBay);
    
    // Handle SKU format conversion first
    const originalSku = variant.sku;
    if (originalSku.includes('|')) {
      await this.migrateSkuFormat(eBay, originalSku);
      variant.sku = originalSku.replace('|', '_');
    }

    if (quantity > 0) {
      // Check if offers already exist for this SKU
      const existingOffers = await this.getOffers(eBay, variant.sku);
      
      if (existingOffers.length > 0) {
        // Update existing offers and inventory for quantity/price changes
        this.log(`Found ${existingOffers.length} existing offers, updating quantities and prices...`);
        await this.updateExistingOffers(eBay, product, variant, category, quantity, price, existingOffers);
      } else {
        // Create new inventory item and offer
        this.log('No existing offers found, creating new inventory item and offer...');
        await this.createNewInventoryAndOffer(eBay, product, variant, category, quantity, price);
      }
    } else {
      // Remove all offers and inventory for this SKU
      await this.removeProduct(eBay, product, variant);
    }

    return { quantity };
  }

  private async migrateSkuFormat(eBay: eBayApi, originalSku: string): Promise<void> {
    const offersWithPipe = await this.getOffers(eBay, originalSku);
    
    if (offersWithPipe.length > 0) {
      this.log(`Found ${offersWithPipe.length} existing offers with SKU ${originalSku}, migrating to use _ instead of |`);
      
      // Update each offer to use the new SKU
      for (const offer of offersWithPipe) {
        try {
          const fullOffer = await eBay.sell.inventory.getOffer(offer.offerId);
          await eBay.sell.inventory.updateOffer(offer.offerId, {
            ...fullOffer,
            sku: originalSku.replace('|', '_')
          });
          this.log(`Updated offer ${offer.offerId} SKU from ${originalSku} to ${originalSku.replace('|', '_')}`);
        } catch (e) {
          this.log(`Error updating offer ${offer.offerId}:`, e);
        }
      }
      
      // Update the inventory item SKU
      try {
        const inventoryItem = await eBay.sell.inventory.getInventoryItem(originalSku);
        await eBay.sell.inventory.createOrReplaceInventoryItem(
          originalSku.replace('|', '_'), 
          inventoryItem
        );
        await eBay.sell.inventory.deleteInventoryItem(originalSku);
        this.log(`Updated inventory item SKU from ${originalSku} to ${originalSku.replace('|', '_')}`);
      } catch (e) {
        this.log(`Error updating inventory item SKU:`, e);
      }
    }
  }

  private async updateExistingOffers(
    eBay: eBayApi,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
    existingOffers: Offer[]
  ): Promise<void> {
    // Update inventory item quantity
    this.log('Updating inventory item quantity...');
    const ebayInventoryItem: InventoryItem = convertCardToInventory(product, variant, category, quantity);
    await eBay.sell.inventory.createOrReplaceInventoryItem(variant.sku, ebayInventoryItem);
    this.log('Inventory item quantity updated successfully');

    // Update each existing offer with new quantity and price
    for (const offer of existingOffers) {
      try {
        const fullOffer = await eBay.sell.inventory.getOffer(offer.offerId);
        const updatedOffer = {
          ...fullOffer,
          availableQuantity: quantity,
          price: {
            value: price.toString(),
            currency: 'USD'
          }
        };
        
        await eBay.sell.inventory.updateOffer(offer.offerId, updatedOffer);
        this.log(`Updated offer ${offer.offerId} with quantity ${quantity} and price ${price}`);
      } catch (e) {
        this.log(`Error updating offer ${offer.offerId}:`, e);
        throw e;
      }
    }
  }

  private async createNewInventoryAndOffer(
    eBay: eBayApi,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number
  ): Promise<void> {
    // Create the new inventory item
    this.log('Creating inventory item...');
    const ebayInventoryItem: InventoryItem = convertCardToInventory(product, variant, category, quantity);
    await eBay.sell.inventory.createOrReplaceInventoryItem(variant.sku, ebayInventoryItem);
    this.log('Inventory item created successfully');

    // Verify location exists and is enabled
    try {
      const locations = await eBay.sell.inventory.getInventoryLocations();
      const cardListerLocation = locations.locations?.find(loc => loc.merchantLocationKey === 'CardLister');
    
      if (!cardListerLocation) {
        throw new Error('CardLister location not found in available locations');
      }
    
      if (cardListerLocation.merchantLocationStatus !== 'ENABLED') {
        throw new Error(`CardLister location is not enabled. Status: ${cardListerLocation.merchantLocationStatus}`);
      }
    } catch (e) {
      this.log('Error querying locations:');
      this.log(JSON.stringify(e, null, 2));
      throw e;
    }

    // Create the new offer
    this.log('Creating offer...');
    const newOffer = createOfferForCard(product, variant, category, quantity, price);
    const { offerId } = await eBay.sell.inventory.createOffer(newOffer);
    this.log(`Offer created with ID: ${offerId}`);

    // Publish the offer
    this.log('Publishing offer...');
    try {
      await eBay.sell.inventory.publishOffer(offerId);
      this.log('Offer published successfully');
    } catch (e) {
      this.log('Error publishing offer:');
      this.log(JSON.stringify(e, null, 2));
      throw e;
    }
  }

  private async ensureLocationExists (eBay: eBayApi): Promise<void> {
    try {
      await eBay.sell.inventory.getInventoryLocation('CardLister');
    } catch (e) {
      if (e.meta?.errorId === 25804) {
        // Location doesn't exist, create it
        await eBay.sell.inventory.createInventoryLocation('CardLister', {
          location: {
            address: {
              addressLine1: '3458 Edinburgh Rd',
              city: 'Green Bay',
              country: 'US',
              postalCode: '54311',
              stateOrProvince: 'WI',
            },
          },
          locationWebUrl: 'www.edvedafi.com',
          merchantLocationStatus: 'ENABLED',
          name: 'CardLister',
        });
      } else {
        throw e;
      }
    }

    try {
      const locations = await eBay.sell.inventory.getInventoryLocations();
      this.log('Available merchant locations:');
      this.log(JSON.stringify(locations, null, 2));
    } catch (e) {
      this.log('Error getting merchant locations:', e);
    }
  }
}

function convertCardToInventory(
  card: Product,
  variant: ProductVariant,
  category: ProductCategory,
  quantity: number,
): InventoryItem {
  if (!variant.metadata) variant.metadata = {};
  const inventoryItem: InventoryItem = {

    "availability": {
    "shipToLocationAvailability": {
      "availabilityDistributions": [
        {
          "merchantLocationKey": "CardLister",
          "quantity": quantity,
          "fulfillmentTime": {
            "value": 1,
            "unit": "DAY"
          }
        }
      ],
        "quantity": quantity
    }
  },
    condition: variant.metadata.grade ? 'LIKE_NEW' : 'USED_VERY_GOOD', // could be "2750 :4000" instead?
    //'ConditionEnum : [NEW,LIKE_NEW,NEW_OTHER,NEW_WITH_DEFECTS,MANUFACTURER_REFURBISHED,CERTIFIED_REFURBISHED,EXCELLENT_REFURBISHED,VERY_GOOD_REFURBISHED,GOOD_REFURBISHED,SELLER_REFURBISHED,USED_EXCELLENT,USED_VERY_GOOD,USED_GOOD,USED_ACCEPTABLE,FOR_PARTS_OR_NOT_WORKING]',
    // conditionDescription: 'string',
    // need to support graded as well, this is only ungraded
    conditionDescriptors: variant.metadata.grade
      ? [
          {
            name: '27501',
            values: [graderIds[variant.metadata.grader as string] || 2750123],
          },
          {
            name: '27502',
            values: [gradeIds[variant.metadata.grade as string]],
          },
          {
            name: '27503',
            values: [variant.metadata.certNumber],
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
      title: variant.title,
      // subtitle: 'string',
      brand: category.metadata.brand as string,
      description: `${variant.metadata.description}
                  <br><br>
                   All shipping is with quality (though often used) top loaders, securely packaged and protected in an envelope if you choose the low-cost Ebay Standard Envelope option. If you would like true tracking and a bubble mailer for further protection please choose the First Class Mail option. Please know your card will be packaged equally securely in both options!`,
      // ean: ['string'],
      // epid: 'string',
      imageUrls: [
        `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${variant.metadata.frontImage}?alt=media`,
        `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${variant.metadata.backImage}?alt=media`,
      ],
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
    Franchise: displayOrNA(variant.metadata.teams),
    team: displayOrNA(variant.metadata.teams),
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
    Character: variant.metadata.player,
    'Player/Athlete': variant.metadata.player,
    'Autograph Authentication': displayOrNA(variant.metadata.autograph, category.metadata.brand),
    Grade: displayOrNA(variant.metadata.grade),
    Graded: booleanText(variant.metadata.graded),
    'Autograph Format': displayOrNA(variant.metadata.autograph),
    'Professional Grader': displayOrNA(variant.metadata.grader),
    'Certification Number': displayOrNA(variant.metadata.certNumber),
    'Autograph Authentication Number': displayOrNA(variant.metadata.certNumber),
    Features: displayOrNA(variant.metadata.features),
    'Parallel/Variety': [
      category.metadata.parallel ||
        (category.metadata.insert && !isNo(category.metadata.insert) ? 'Base Insert' : 'Base Set'),
    ],
    Autographed: variant.metadata.autograph && variant.metadata.autograph !== 'None' ? ['Yes'] : ['No'],
    'Card Name': [variant.metadata?.cardName || card.metadata?.cardName],
    'Card Number': [variant.metadata.cardNumber],
    'Signed By': displayOrNA(variant.metadata.autograph, variant.metadata.player),
    Material: [card.material],
    'Card Size': [variant.metadata.size],
    'Card Thickness': getThickness(variant.metadata.thickness as string),
    Language: [category.metadata.language || 'English'],
    'Original/Licensed Reprint': [category.metadata.original || 'Original'],
    Vintage: booleanText(parseInt(card.metadata.year as string) < 1986),
    'Card Condition': [variant.metadata.condition || 'Excellent'],
    'Convention/Event': displayOrNA(variant.metadata.convention),
    'Insert Set': [variant.metadata.insert || 'Base Set'],
    'Print Run': displayOrNA(variant.metadata.printRun),
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
  format: 'FIXED_PRICE', //"FormatTypeEnum : [AUCTION,FIXED_PRICE]",
  hideBuyerDetails: true,
  listingDuration: 'GTC', //"ListingDurationEnum : [DAYS_1,DAYS_3,DAYS_5,DAYS_7,DAYS_10,DAYS_21,DAYS_30,GTC]",
  listingPolicies: {
    bestOfferTerms: {
      bestOfferEnabled: true,
    },
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

const displayOrNA = (testValue: string | boolean | unknown, displayValue: unknown = testValue): string[] => {
  if (Array.isArray(displayValue) && displayValue.length > 0) {
    return displayValue.map(titleCase).filter((v) => v.trim().length > 0);
  } else {
    return [testValue && !isNo(testValue.toString()) ? titleCase(displayValue.toString()) : 'N/A'];
  }
};

export const displayYear = (year: string): string => (year.indexOf('-') > -1 ? year.split('-')[0] : year);

export const getThickness = (thickness: string): string[] => [
  thickness.toLowerCase().indexOf('pt') < 0 ? `${thickness} Pt.` : thickness,
];

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

export default EbayListingStrategy;
