import { Product, ProductCategory } from '@medusajs/medusa';
import { remote } from 'webdriverio';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { getBrowserlessConfig } from '../utils/browserless';
import { BscCard } from '../models/bsc-card';
import AbstractListingStrategy from './AbstractListingStrategy';

class BscListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'bsc-strategy';
  static batchType = 'bsc-sync';
  static listingSite = 'BSC';

  async removeAllInventory(api: AxiosInstance, category: ProductCategory): Promise<void> {
    //nothing to do here yet!
  }

  async login() {
    const browser = await remote(getBrowserlessConfig('https://www.buysportscards.com/', 'BSC_LOG_LEVEL'));

    let api: AxiosInstance;
    try {
      await browser.url('/');
      const signInButton = await browser.$('.=Sign In');
      await signInButton.waitForClickable({ timeout: 10000 });
      await signInButton.click();

      const emailInput = await browser.$('#signInName');
      await emailInput.waitForExist({ timeout: 5000 });
      await emailInput.setValue(process.env.BSC_EMAIL);
      await browser.$('#password').setValue(process.env.BSC_PASSWORD);

      await browser.$('#next').click();

      await browser.$('.=welcome back,').waitForExist({ timeout: 10000 });

      const reduxAsString: string = await browser.execute(
        'return Object.values(localStorage).filter((value) => value.includes("secret")).find(value=>value.includes("Bearer"));',
      );
      const redux = JSON.parse(reduxAsString);

      api = this.loginAxios('https://api-prod.buysportscards.com/', {
        assumedrole: 'sellers',
        authority: 'api-prod.buysportscards.com',
        authorization: `Bearer ${redux.secret.trim()}`,
      });
    } finally {
      try {
        await browser?.deleteSession();
      } catch (e) {
        //TODO need to log this somewhere actionable, but don't want to throw an error
        this.log(`login::cleanup:: Failed to close browser session. Proceeding, but may cause leak! :: ${e.message}`);
      }
    }
    return api;
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
      const product = products.find((product) => `${product.metadata.cardNumber}` === `${listing.card.cardNo}`);
      if (product) {
        const variant = product?.variants[0]; //TODO This will need to handle multiple variants
        const quantity = await this.getQuantity({ variant });

        if (quantity !== listing.availableQuantity || (listing.sellerSku && listing.sellerSku !== variant.sku)) {
          const newListing: BscCard = {
            ...listing,
            availableQuantity: quantity,
            price: this.getPrice(variant),
            sellerSku: variant.sku,
          };

          // TODO Fix images
          if (product.images) {
            const images = product.images.map((image) => image.url).sort();
            if (images.length > 0 && (!listing.sellerImgFront || listing.sellerImgFront.indexOf('Default') > -1)) {
              newListing.sellerImgFront = await this.postImage(api, `${images[0]}`);
            }
            if (images.length > 1 && (!listing.sellerImgBack || listing.sellerImgBack.indexOf('Default') > -1)) {
              newListing.sellerImgBack = await this.postImage(api, `${images[1]}`);
            }
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
