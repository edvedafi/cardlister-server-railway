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
let isPaused: boolean = false;

export const showSpinner = (spinnerName: string, message: string) => {
  if (getSpinners().pick(spinnerName)) {
    updateSpinner(spinnerName, message);
  } else {
    getSpinners().add(spinnerName, { text: message });
    if (isPaused) {
      _paused.push({ name: spinnerName, spinner: getSpinners().pick(spinnerName) });
      pauseSpinners();
    }
  }
};

export const updateSpinner = (spinnerName: string, message: string) => {
  const spinner = getSpinners().pick(spinnerName);
  if (spinner) {
    if (isPaused) {
      const pausedSpinner = _paused.find((s) => s.name === spinnerName);
      if (pausedSpinner) {
        pausedSpinner.spinner.text = message;
      } else {
        showSpinner(spinnerName, message);
      }
    } else {
      getSpinners().update(spinnerName, { text: message });
    }
  } else {
    showSpinner(spinnerName, message);
  }
};

export const pauseSpinners = () => {
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
  isPaused = true;
  return paused;
};

export const resumeSpinners = (pausedSpinners = _paused) => {
  pausedSpinners.forEach((spinner) => {
    getSpinners().remove(spinner.name);
    getSpinners().add(spinner.name, { ...spinner.spinner });
  });
  _paused = [];
  _pausedFinishes.forEach((finish) => finishSpinner(finish.name, finish.message));
  _pausedFinishes = [];
  _pausedErrors.forEach((error) => errorSpinner(error.name, error.message));
  _pausedErrors = [];
  isPaused = false;
};

export const finishSpinner = (spinnerName: string, message: string) => {
  const s = getSpinners().pick(spinnerName);
  if (isPaused) {
    _paused = _paused.filter((s) => s.name !== spinnerName);
    if (message) {
      _pausedFinishes.push({ name: spinnerName, message });
    }
  } else if (message) {
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
  if (isPaused) {
    _paused = _paused.filter((s) => s.name !== spinnerName);
    _pausedErrors.push({ name: spinnerName, message: message });
  } else {
    if (!getSpinners().pick(spinnerName)) {
      getSpinners().add(spinnerName, { text: message });
    }
    getSpinners().fail(spinnerName, { text: message });
  }
};

const log = (color: ChalkInstance, ...args: unknown[]) => {
  pauseSpinners();
  console.log(
    ...args.map((arg) => {
      if (arg instanceof Error) {
        return arg;
      } else {
        return typeof arg === 'string' ? color(arg) : color(JSON.stringify(arg, null, 2));
      }
    }),
  );
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
