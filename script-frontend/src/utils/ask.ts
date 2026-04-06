//comment out the body of this to be prompted
import { confirm as confirmPrompt, input } from '@inquirer/prompts';
import { isNo, isYes } from './data.js';
import filterSelectPrompt from './filterSelectPrompt.js';
import { pauseSpinners, resumeSpinners } from './spinners.js';
import { submitUITask, uiTaskActive } from './uiQueue.js';

export type AskSelectOption<T = unknown> = {
  value: T;
  name: string;
};

export type AskOptions = {
  maxLength?: number;
  selectOptions?: string[] | AskSelectOption[];
  isYN?: boolean;
  isArray?: boolean;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
};

/**
 * Prompt the user for input.
 *
 * If called from inside a UI task (uiTaskActive === true), runs the prompt
 * inline — we already own the UI thread. Otherwise submits a new UI task so
 * the prompt is serialized against any other interactive work.
 */
export const ask = async (
  questionText: string,
  defaultAnswer: any = undefined,
  { maxLength, selectOptions, isYN = false, isArray = false, validate }: AskOptions = {},
): Promise<any> => {
  if (isArray) {
    const defaultAnswers = defaultAnswer ? (defaultAnswer as unknown[]) : [];
    const result: unknown[] = [];
    let i = 0;
    let answer;
    do {
      answer = await askOne(questionText, defaultAnswers[i], { maxLength, selectOptions, isYN, validate });
      if (answer) {
        result.push(answer);
      }
      i++;
    } while (answer);
    return result;
  }
  return askOne(questionText, defaultAnswer, { maxLength, selectOptions, isYN, validate });
};

const askOne = async (
  questionText: string,
  defaultAnswer: any,
  opts: Omit<AskOptions, 'isArray'>,
): Promise<any> => {
  if (uiTaskActive()) {
    // Already inside a UI task — run inline. Any nested awaits keep the flag set.
    return askInternal(questionText, defaultAnswer, opts);
  }
  return submitUITask('log', () => askInternal(questionText, defaultAnswer, opts));
};

const askInternal = async (
  questionText: string,
  defaultAnswer: any = undefined,
  { maxLength, selectOptions, isYN, validate }: Omit<AskOptions, 'isArray'> = {},
): Promise<any> => {
  pauseSpinners();
  try {
    if (typeof defaultAnswer === 'boolean' || isYes(defaultAnswer) || isNo(defaultAnswer)) {
      isYN = true;
    }
    let answer;
    if (selectOptions) {
      const choices = selectOptions.map((option) => (typeof option === 'string' ? { value: option } : option));
      answer = await filterSelectPrompt({
        message: questionText,
        choices: choices,
        default: defaultAnswer,
        cancelable: true,
      });
    } else {
      let displayText = questionText;
      if (maxLength) {
        if (defaultAnswer && defaultAnswer.length > maxLength) {
          displayText = `${questionText} [Max Length ${maxLength} Characters. Current: ${defaultAnswer.length}]`;
        } else {
          displayText = `${questionText} [Max Length ${maxLength} Characters]`;
        }
      }

      displayText = `${displayText}:`;
      if (isYN) {
        answer = await confirmPrompt({
          message: displayText,
          default: defaultAnswer,
        });
      } else {
        answer = await input({ message: displayText, default: defaultAnswer, validate });
      }

      if (maxLength && typeof answer === 'string' && answer.length > maxLength) {
        answer = await askInternal(questionText, answer, { maxLength });
      }
    }

    return answer;
  } finally {
    resumeSpinners();
  }
};

/**
 * Log a message through the UI queue so it never clobbers an active prompt.
 * If called from inside a UI task, logs inline (we own the thread); otherwise
 * submits a log task.
 */
export const queuedLog = (...args: unknown[]): Promise<void> => {
  if (uiTaskActive()) {
    pauseSpinners();
    // eslint-disable-next-line no-console
    console.log(...args);
    resumeSpinners();
    return Promise.resolve();
  }
  return submitUITask('log', async () => {
    pauseSpinners();
    // eslint-disable-next-line no-console
    console.log(...args);
    resumeSpinners();
  }) as Promise<void>;
};
