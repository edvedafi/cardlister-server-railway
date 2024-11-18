import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy, { ListAttempt } from './AbstractListingStrategy';
import * as console from 'node:console';
import { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { JSDOM } from 'jsdom';

class McpListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'mcp-strategy';
  static batchType = 'mcp-sync';
  static listingSite = 'MCP';
  requireImages = true;
  private token: string;

  async login() {
    const api = super.loginAxios('https://mycardpost.com/', { 'User-Agent': 'Mozilla/5.0' }, true);

    const getLogin = await api.get('login');
    const csrfTokenMatch = getLogin.data.match(/name="_token" value="(.*?)"/);
    if (!csrfTokenMatch) {
      throw new Error('Failed to retrieve CSRF token');
    }
    this.token = csrfTokenMatch[1];
    const loginData = new FormData();
    loginData.append('_token', this.token);
    loginData.append('email', process.env.MCP_EMAIL);
    loginData.append('password', process.env.MCP_PASSWORD);
    loginData.append('remember', 'on');
    const loginResponse2 = await api.post('https://mycardpost.com/login', loginData, {
      headers: {
        ...loginData.getHeaders(),
      },
    });

    if (loginResponse2.data.includes('Invalid Credentials!')) {
      throw new Error('Invalid Credentials!');
    }

    return api;
  }

  async removeProduct(api: AxiosInstance, product: Product, productVariant: ProductVariant): Promise<ListAttempt> {
    if (productVariant.metadata.mcpId) {
      try {
        const deleted = await api.get(`/delete-card/${productVariant.metadata.mcpId}`);
        if (deleted.status === 302 || deleted.status === 200) {
          return { quantity: 1 };
        } else {
          return { error: `Failed to delete card (${deleted.status}: ${deleted.statusText})` };
        }
      } catch (error) {
        if (error.response.status === 404) {
          return { quantity: 1 };
        } else {
          return { error: error.message };
        }
      }
    }
    return { skipped: true };
  }

  async syncProduct(
    api: AxiosInstance,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    if (productVariant.metadata.mcpId) {
      try {
        const detailsPage = await api.get(`/card-details/${productVariant.metadata.mcpId}`);
        if (detailsPage.status === 200) {
          return { skipped: true };
        }
      } catch (error) {
        if (error.response.status === 404) {
          productVariant.metadata.mcpId = null;
        } else {
          return { error: error.message };
        }
      }
    }
    const formData = new FormData();
    const features: string[] = (productVariant.metadata.features as string[])?.map((f) => f.toLowerCase()) || [];

    // Append fields to FormData
    formData.append('_token', this.token);
    formData.append(
      'front_image_url',
      `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.metadata.frontImage}?alt=media`,
    );
    formData.append(
      'back_image_url',
      `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.metadata.backImage}?alt=media`,
    );
    formData.append('added_from', '0');
    formData.append('name', `${productVariant.title} [${productVariant.sku}]`);
    formData.append('price', `${price}`);
    formData.append(
      'sport',
      {
        football: '6',
        baseball: '76',
        basketball: '77',
        hockey: '75',
        soccer: '78',
        golf: '79',
        ufc: '80',
        boxing: '112',
        formula1: '81',
        nascar: '786',
        wwe: '1',
        pokemon: '115',
        marvel: '117',
        disney: '150',
        'star wars': '118',
        veefriends: '417',
        entertainment: '314',
        tcg: '318',
        'magic: the gathering': '2448',
        tennis: '334',
        other: '82',
      }[(<string>category.metadata.sport).toLowerCase()],
    );

    (<string[]>productVariant.metadata.teams).reduce((acc, team) => {
      formData.append('team', `[{"value":"${team}","style":"--tag-bg:hsl(223,57%,66%)"}]`);
      return `${acc ? `${acc},` : ''}{"value":"${team}","style":"--tag-bg:hsl(223,57%,66%)"}`;
    }, '');

    formData.append(
      'team',
      `[${(<string[]>productVariant.metadata.teams).reduce((acc, team) => `${acc ? `${acc},` : ''}{"value":"${team}","style":"--tag-bg:hsl(223,57%,66%)"}`, '')}]`,
    );
    formData.append('card_type', '2'); // Hardcoded to 'Raw' for now
    formData.append('serial_number', `${productVariant.metadata.printRun}`);
    if (features.includes('rc')) {
      formData.append('attribute_name[]', '45');
    }
    if (<number>productVariant.metadata.printRun > 0) {
      formData.append('attribute_name[]', '88');
      if (<number>productVariant.metadata.printRun === 1) {
        formData.append('attribute_name[]', '42');
      }
    }
    if (productVariant.metadata.autographed) {
      formData.append('attribute_name[]', '84');
    }
    if (features.includes('jersey') || features.includes('patch')) {
      formData.append('attribute_name[]', '214');
      formData.append('attribute_name[]', '43');
    }
    if (
      features.includes('ssp') ||
      features.includes('sp') ||
      features.includes('sport print') ||
      features.includes('variation')
    ) {
      formData.append('attribute_name[]', '46');
    }
    if (category.metadata.insert) {
      formData.append('attribute_name[]', '215');
    }

    if (category.metadata.parallel) {
      formData.append('attribute_name[]', '331');
      if ((<string>category.metadata.parallel).toLowerCase().includes('refractor')) {
        formData.append('attribute_name[]', '213');
      }
      if ((<string>category.metadata.parallel).toLowerCase().includes('foil')) {
        formData.append('attribute_name[]', '2456');
      }
    }
    if (features.includes('case') || features.includes('case hit') || features.includes('ssp')) {
      formData.append('attribute_name[]', '383');
    }
    if (<number>category.metadata.year < 1980) {
      formData.append('attribute_name[]', '520');
    }
    if (features.includes('jersey number') || features.includes('jersey numbered')) {
      formData.append('attribute_name[]', '355');
    }
    formData.append('details', `${productVariant.metadata.description}\n\n[${productVariant.sku}]`);
    formData.append('open_to_offer', '1');
    formData.append('minimum_offer_price', '0');

    try {
      const addCardResponse = await api.post('add-card', formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      // console.log('Card Added Successfully:', addCardResponse.data);
      if (addCardResponse.data.success) {
        //get the card id
        const html = await api.get('edvedafi?tab=shop');

        const dom = new JSDOM(html.data);
        const firstCardBlk = dom.window.document.querySelector('.card-blk');

        if (firstCardBlk) {
          // Find the link in the first card-blk div
          const link = firstCardBlk.querySelector('a[href^="https://mycardpost.com/card-details/"]');
          if (link) {
            const href = link.getAttribute('href');
            const match = href.match(/https:\/\/mycardpost\.com\/card-details\/(\d+)/);
            if (match) {
              // console.log('Listing ID:', match[1]);
              return {
                platformMetadata: {
                  mcpId: match[1],
                },
                quantity: 1,
              };
            } else {
              throw new Error('No matching number found in the href.');
            }
          } else {
            throw new Error('No matching link found in the first card-blk.');
          }
        } else {
          throw new Error('No card-blk div found.');
        }
      } else {
        return { error: `Error uploading card ${addCardResponse.data.message}` };
      }
    } catch (error) {
      console.error('Error uploading card:', error.response?.data || error.message);
      // Log request details
      if (error.config) {
        console.error('Request Headers:', error.config.headers);
        console.error('Request Body:', error.config.data.get('_token'));
        error.config.data._streams.forEach((stream) => {
          if (typeof stream === 'string') {
            console.log(stream);
          } else {
            console.log('File or Binary Data Detected');
          }
        });
        console.error('Request URL:', error.config.url);
        console.error('Request Method:', error.config.method);
      }
      return { error: `Error uploading card: ${error.message}` };
    }
  }
}

export default McpListingStrategy;
