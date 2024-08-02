import {
  CartService,
  CustomerService,
  DraftOrder,
  DraftOrderService,
  LineItem,
  Logger,
  Order,
  OrderService,
  ProductVariantService,
  RegionService,
  TransactionBaseService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { login as ebayLogin } from '../utils/ebayAPI';
import SyncService from './sync';
import process from 'node:process';

type InjectedDependencies = {
  cartService: CartService;
  customerService: CustomerService;
  draftOrderService: DraftOrderService;
  orderService: OrderService;
  productVariantService: ProductVariantService;
  regionService: RegionService;
  syncService: SyncService;

  manager: EntityManager;
  logger: Logger;
};


class MCPService extends TransactionBaseService {
  protected readonly cartService: CartService;
  protected readonly customerService: CustomerService;
  protected readonly draftOrderService: DraftOrderService;
  protected readonly orderService: OrderService;
  protected readonly productVariantService: ProductVariantService;
  protected readonly regionService: RegionService;
  protected readonly syncService: SyncService;

  protected readonly logger: Logger;

  constructor({
                cartService,
                customerService,
                draftOrderService,
                orderService,
                productVariantService,
                regionService,
                syncService,
                logger,
              }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);

    this.cartService = cartService;
    this.customerService = customerService;
    this.draftOrderService = draftOrderService;
    this.orderService = orderService;
    this.productVariantService = productVariantService;
    this.logger = logger;
    this.regionService = regionService;
    this.syncService = syncService;
  }

  async login() {
    const browser = await this.loginWebDriver('https://www.mycardpost.com/');

    await browser.url('login');
    await browser.$('input[type="email"]').setValue(process.env.MCP_EMAIL);
    await browser.$('input[type="password"]').setValue(process.env.MCP_PASSWORD);
    await browser.$('button=Login').click();

    let toast: WebdriverIO.Element;
    try {
      toast = await browser.$('.toast-message');
    } catch (e) {
      // no toast so all is good
    }
    if (toast && (await toast.isDisplayed())) {
      const resultText = await toast.getText();
      if (resultText.indexOf('Invalid Credentials') > -1) {
        throw new Error('Invalid Credentials');
      }
    }

    await browser.url('edvedafi?tab=shop');

    return browser;
  }

  async removeCardFromMCP(sku: string) {
    // Remove card from MyCardPost


  }
}

export default MCPService;
