import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { BscCard } from '../models/bsc-card';
import AbstractListingStrategy from './AbstractListingStrategy';
import { login as bscLogin } from '../utils/bsc';

class BscListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'bsc-strategy';
  static batchType = 'bsc-sync';
  static listingSite = 'BSC';

  async removeAllInventory(api: AxiosInstance, category: ProductCategory): Promise<void> {
    //nothing to do here yet!
  }

  async login(): Promise<AxiosInstance> {
    return bscLogin(await this.loginPuppeteer('https://www.buysportscards.com'), this.loginAxios);
  }

  async postImage(api: AxiosInstance, image: string) {
    const formData = new FormData();

    const response = await axios.get(
      `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${image}?alt=media`,
      { responseType: 'stream' },
    );
    formData.append('attachment', response.data, image);
    const formHeaders = formData.getHeaders();

    const { data: results } = await api.post(
      `https://api-prod.buysportscards.com/common/card/undefined/product/undefined/attachment`,
      formData,
      {
        headers: {
          ...formHeaders,
          'Content-Type': 'multipart/form-data',
        },
      },
    );
    if (results.objectKey) {
      return results.objectKey;
    } else {
      this.log('error uploading image', results); //TODO need to log this somewhere actionable
    }
  }

  async syncProducts(
    api: AxiosInstance,
    products: Product[],
    category: ProductCategory,
    advanceCount: (count: number) => Promise<number>,
  ): Promise<number> {
    const updates = [];
    const response = await api.post('seller/bulk-upload/results', {
      condition: 'near_mint',
      currentListings: true,
      productType: 'raw',
      ...(category.metadata.bsc as object),
    });
    const listings = response.data.results;
    let count = 0;

    for (const listing of listings) {
      let product: Product | undefined;
      let variant: ProductVariant | undefined;
      if (listing.card.playerAttribute.indexOf('VAR') > -1) {
        product = products.find((product) => {
          variant = product.variants.find((variant) => `${variant.metadata.cardNumber}` === `${listing.card.cardNo}`);
          return variant;
        });
      } else {
        product = products.find((product) => `${product.metadata.cardNumber}` === `${listing.card.cardNo}`);
        variant = product?.variants.find((variant) => variant.metadata.isBase);
      }
      if (product && variant) {
        const quantity = await this.getQuantity({ variant });

        if (quantity !== listing.availableQuantity || (listing.sellerSku && listing.sellerSku !== variant.sku)) {
          const newListing: BscCard = {
            ...listing,
            availableQuantity: quantity,
            price: this.getPrice(variant),
            sellerSku: variant.sku,
          };

          if (
            variant.metadata.frontImage &&
            (!listing.sellerImgFront || listing.sellerImgFront.indexOf('Default') > -1)
          ) {
            newListing.sellerImgFront = await this.postImage(api, <string>variant.metadata.frontImage);
          }
          if (variant.metadata.backImage && (!listing.sellerImgBack || listing.sellerImgBack.indexOf('Default') > -1)) {
            newListing.sellerImgBack = await this.postImage(api, <string>variant.metadata.backImage);
          }
          updates.push(newListing);
        }
      } else {
        this.log('product not found for: ', listing.card.cardNo); //TODO need to log this somewhere actionable
      }
      count = await advanceCount(count);
    }

    if (updates.length > 0) {
      const { data: results } = await api.put('seller/bulk-upload', {
        sellerId: 'cf987f7871',
        listings: updates,
      });
      if (results.result !== 'Saved!') {
        throw new Error(results);
      }
    }
    return updates.length;
  }
}

export default BscListingStrategy;
