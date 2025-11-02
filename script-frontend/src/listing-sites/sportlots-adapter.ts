import type { Category, SetInfo } from '../models/setInfo';
import { retryWithExponentialBackoff } from '../utils/retry';
import { useSpinners } from '../utils/spinners';
import chalk from 'chalk';

const { log } = useSpinners('SportLots Adapter', chalk.magentaBright);

type Implementation = 'webdriver' | 'forms';

let implementation: Implementation = (process.env.SL_IMPL as Implementation) === 'forms' ? 'forms' : 'webdriver';

export function setSportlotsImplementation(impl: Implementation): void {
  implementation = impl;
}

async function loadModule(): Promise<any> {
  if (implementation === 'forms') {
    return await import('./sportlots-forms');
  }
  return await import('./sportlots');
}

export async function getSLSport(defaultName?: string): Promise<any> {
  const mod = await loadModule();
  return await mod.getSLSport(defaultName);
}

export async function getSLYear(defaultName?: string): Promise<any> {
  const mod = await loadModule();
  return await mod.getSLYear(defaultName);
}

export async function getSLBrand(defaultName?: string): Promise<any> {
  const mod = await loadModule();
  return await mod.getSLBrand(defaultName);
}

export async function getSLSet(setInfo: SetInfo): Promise<any> {
  const mod = await loadModule();
  return await retryWithExponentialBackoff(
    async () => {
      return await mod.getSLSet(setInfo);
    },
    3,
    1000,
    2,
    undefined,
    async (attempt, error, delayMs) => {
      log(`Error getting SL set (attempt ${attempt}/3): ${error}`);
      log(`Shutting down browser and retrying in ${delayMs}ms...`);
      // Shut down the browser before retrying to start fresh
      await shutdownSportLots();
    }
  );
}

export async function getSLCards(
  setInfo: SetInfo & { year: Category; brand: Category; sport: Category },
  category: Category,
  expectedCards: number,
): Promise<any> {
  const mod = await loadModule();
  return await mod.getSLCards(setInfo, category, expectedCards);
}

export async function shutdownSportLots(): Promise<void> {
  const mod = await loadModule();
  if (implementation === 'forms') {
    if (typeof mod.shutdownSportLotsForms === 'function') {
      await mod.shutdownSportLotsForms();
      return;
    }
  }
  if (typeof mod.shutdownSportLots === 'function') {
    await mod.shutdownSportLots();
  }
}


