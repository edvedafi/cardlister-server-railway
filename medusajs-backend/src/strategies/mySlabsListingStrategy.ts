import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import { AxiosInstance } from 'axios';
import AbstractListingStrategy, { ListAttempt } from './AbstractListingStrategy';
import { categories, graders, login as mySlabsLogin, Slab } from '../utils/mySlabs';

class MySlabsListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'myslabs-strategy';
  static batchType = 'myslabs-sync';
  static listingSite = 'MySlabs';
  requireImages = true;
  minPrice = 10;

  async login(): Promise<AxiosInstance> {
    return mySlabsLogin(this.loginAxios);
  }

  async removeProduct(
    connection: AxiosInstance,
    product: Product,
    productVariant: ProductVariant,
  ): Promise<ListAttempt> {
    if (productVariant.metadata.mySlabsId) {
      try {
        const response = await connection.delete(`/slabs/${productVariant.metadata.mySlabsId}`);
        if (response.status === 204) {
          return { quantity: 1 };
        } else {
          return {
            error: `${response.status} ${response.statusText}: ${response.data}`,
          };
        }
      } catch (error) {
        if (error.response.status === 404) {
          return { skipped: true };
        } else {
          return { error: error.message };
        }
      }
    } else {
      return { skipped: true };
    }
  }

  async syncProduct(
    api: AxiosInstance,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    if (productVariant.metadata.mySlabsId) {
      try {
        const slabResponse = await api.get(`/slabs/${productVariant.metadata.mySlabsId}`);
        if (slabResponse.status === 200) {
          return { skipped: true };
        }
      } catch (error) {
        if (error.response.status === 404) {
          productVariant.metadata.mySlabsId = null;
        } else {
          return { error: error.message };
        }
      }
    }

    const slab: Partial<Slab> = {
      title: productVariant.title,
      price: `${price}`,
      description: <string>productVariant.metadata.description || product.description,
      category: categories[(<string>category.metadata.sport).toUpperCase()] || 'OTHER',
      year: parseInt(<string>category.metadata.year),
      for_sale: true,
      allow_offer: true,
      minimum_offer: 0,
      external_id: productVariant.sku,
      slab_image_1: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.metadata.frontImage}?alt=media`,
      slab_image_2: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.metadata.backImage}?alt=media`,
    };

    if (productVariant.metadata.graded) {
      slab.publish_type = 'SLABBED_CARD';
      slab.card_type = graders[<string>productVariant.metadata.grader];
      slab.grade = parseFloat(<string>productVariant.metadata.grade);
    } else {
      slab.publish_type = 'RAW_CARD_SINGLE';
      slab.condition = 'MYSLABS_B';
    }

    const slabResponse = await api.post('/slabs', slab);
    if (slabResponse.status === 201) {
      return {
        quantity: 1,
        platformMetadata: {
          mySlabsId: slabResponse.data.id,
        },
      };
    } else {
      return {
        error: `${slabResponse.status} ${slabResponse.statusText}: ${slabResponse.data}`,
      };
    }
  }
}

export default MySlabsListingStrategy;
