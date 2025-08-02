import dotenv from 'dotenv';
import 'zx/globals';
import { loginEbayAPI } from './old-scripts/ebay';

$.verbose = false;

dotenv.config();

await loginEbayAPI();
