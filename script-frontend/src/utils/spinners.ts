import Spinnies from 'spinnies';
import chalk, { type ChalkInstance } from 'chalk';

let spinners: Spinnies;

const getSpinners = () => {
  if (!spinners) {
    spinners = new Spinnies();
  }
  return spinners;
};

type Spinners = { name: string; spinner: Spinnies.SpinnerOptions }[];
type Messages = { name: string; message: string }[];
let _paused: Spinners = [];
let _pausedFinishes: Messages = [];
let _pausedErrors: Messages = [];
let pauseDepth: number = 0;
const isPaused = () => pauseDepth > 0;

export const showSpinner = (spinnerName: string, message: string) => {
  if (isPaused()) {
    // While paused, record the spinner in the buffer but don't render it.
    const existing = _paused.find((s) => s.name === spinnerName);
    if (existing) {
      existing.spinner.text = message;
    } else {
      _paused.push({ name: spinnerName, spinner: { text: message } as Spinnies.SpinnerOptions });
    }
    return;
  }
  if (getSpinners().pick(spinnerName)) {
    updateSpinner(spinnerName, message);
  } else {
    getSpinners().add(spinnerName, { text: message });
  }
};

export const updateSpinner = (spinnerName: string, message: string) => {
  if (isPaused()) {
    const pausedSpinner = _paused.find((s) => s.name === spinnerName);
    if (pausedSpinner) {
      pausedSpinner.spinner.text = message;
    } else {
      showSpinner(spinnerName, message);
    }
    return;
  }
  const spinner = getSpinners().pick(spinnerName);
  if (spinner) {
    getSpinners().update(spinnerName, { text: message });
  } else {
    showSpinner(spinnerName, message);
  }
};

export const pauseSpinners = () => {
  pauseDepth++;
  if (pauseDepth > 1) {
    // Already paused — nothing new to capture or stop.
    return [];
  }
  const spinners = getSpinners();
  const paused: Spinners = [];
  // @ts-expect-error - Using an internal property, yes I know it's a bad idea, but it must be done
  Object.keys(spinners.spinners).forEach((spinner) => {
    const s = spinners.pick(spinner);
    if (s.status !== 'fail' && s.status !== 'succeed') {
      _paused.push({ name: spinner, spinner: s });
      paused.push({ name: spinner, spinner: s });
      spinners.remove(spinner);
    }
  });

  spinners.stopAll();
  return paused;
};

export const resumeSpinners = () => {
  if (pauseDepth === 0) return;
  pauseDepth--;
  if (pauseDepth > 0) {
    // Still inside an outer pause — don't actually resume yet.
    return;
  }
  const toResume = _paused;
  _paused = [];
  toResume.forEach((spinner) => {
    getSpinners().remove(spinner.name);
    getSpinners().add(spinner.name, { ...spinner.spinner });
  });
  const finishes = _pausedFinishes;
  _pausedFinishes = [];
  finishes.forEach((finish) => finishSpinner(finish.name, finish.message));
  const errors = _pausedErrors;
  _pausedErrors = [];
  errors.forEach((error) => errorSpinner(error.name, error.message));
};

export const finishSpinner = (spinnerName: string, message: string) => {
  if (isPaused()) {
    _paused = _paused.filter((s) => s.name !== spinnerName);
    if (message) {
      _pausedFinishes.push({ name: spinnerName, message });
    }
    return message;
  }
  const s = getSpinners().pick(spinnerName);
  if (message) {
    if (!s) {
      getSpinners().add(spinnerName, { text: message });
    }
    getSpinners().succeed(spinnerName, { text: message });
  } else {
    if (s) {
      getSpinners().remove(spinnerName);
      return s?.text;
    }
  }
  return message;
};

export const errorSpinner = (spinnerName: string, message: string) => {
  if (isPaused()) {
    _paused = _paused.filter((s) => s.name !== spinnerName);
    _pausedErrors.push({ name: spinnerName, message: message });
    return;
  }
  if (!getSpinners().pick(spinnerName)) {
    getSpinners().add(spinnerName, { text: message });
  }
  getSpinners().fail(spinnerName, { text: message });
};

const log = (color: ChalkInstance, ...args: unknown[]) => {
  const formatted = args.map((arg) => {
    if (arg instanceof Error) {
      return arg;
    } else {
      return typeof arg === 'string' ? color(arg) : color(JSON.stringify(arg, null, 2));
    }
  });
  pauseSpinners();
  console.log(...formatted);
  resumeSpinners();
};

export type UpdateSpinner = (message: string) => void;
export type FinishSpinner = (message?: string) => string;
export type ErrorSpinner = (info: string | Error | unknown, addition?: string) => void;
export type ShowSpinner = (
  name: string,
  message: string,
) => {
  update: UpdateSpinner;
  finish: FinishSpinner;
  error: ErrorSpinner;
};
export type Log = (...args: unknown[]) => void;
export type RunInSpinner = <T>(name: string, message: string, any: (args: unknown[]) => T, ...args: unknown[]) => T;
export type UseSpinners = {
  showSpinner: ShowSpinner;
  log: Log;
};

export const useSpinners = (processName: string, color: ChalkInstance | string = chalk.white): UseSpinners => {
  const key = `${processName}-spinner`;
  let colorFn: ChalkInstance;
  if (typeof color === 'string') {
    colorFn = chalk.hex(color);
  } else {
    colorFn = color;
  }
  return {
    showSpinner: (name: string, message: string) => {
      showSpinner(`${key}-${name}`, colorFn.inverse(`${message}`));
      return {
        update: (addition: string) => updateSpinner(`${key}-${name}`, colorFn.inverse(`${message} (${addition})`)),
        finish: (addition?: string) =>
          finishSpinner(`${key}-${name}`, addition ? colorFn(`${message} :: ${addition}`) : ''),
        error: (info: string | Error | unknown, addition: string = message) => {
          if (info instanceof Error) {
            log(colorFn, info);
            errorSpinner(`${key}-${name}`, colorFn(`${addition} (${info.message})`));
            throw info;
          } else {
            errorSpinner(`${key}-${name}`, colorFn(`${info} ${addition}`));
          }
        },
      };
    },
    log: (...args: unknown[]) => log(colorFn, ...args),
  };
};
