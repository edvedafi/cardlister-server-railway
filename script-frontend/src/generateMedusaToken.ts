import dotenv from 'dotenv';
import 'zx/globals';
import { ask } from './utils/ask';
import { generateKey } from './utils/medusa';

$.verbose = false;

dotenv.config();

const user = await ask('Enter your username: ');
const pass = await ask('Enter your password: ');
const key = await ask('Enter your key: ');

await generateKey(user, pass, key);
