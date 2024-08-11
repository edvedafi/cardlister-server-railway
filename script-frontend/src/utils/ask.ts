//comment out the body of this to be prompted
import { confirm as confirmPrompt, input } from '@inquirer/prompts';
import { isNo, isYes } from './data.js';
import filterSelectPrompt from './filterSelectPrompt.js';
import { pauseSpinners, resumeSpinners } from './spinners.js';
import Queue from 'queue';

const queueResults: string[] = [];

const queue = new Queue({
  results: queueResults,
  autostart: true,
  concurrency: 1,
});

export type AskSelectOption<T = any> = {
  value: T;
  name: string;
};

export type AskOptions = {
  maxLength?: number;
  selectOptions?: string[] | AskSelectOption[];
  isYN?: boolean;
  cancellable?: boolean;
};

export const ask = async (
  questionText: string,
  defaultAnswer: any = undefined,
  { maxLength, selectOptions, isYN = false, cancellable = false }: AskOptions = {},
): Promise<any> => {
  return await new Promise((resolve) => {
    queue.push(async () => {
      if (cancellable) {
        resolve(askInternal(questionText, defaultAnswer, { maxLength, selectOptions, isYN, cancellable }));
      } else {
        resolve(await askInternal(questionText, defaultAnswer, { maxLength, selectOptions, isYN, cancellable }));
      }
    });
  });
};

const askInternal = async (
  questionText: string,
  defaultAnswer: any = undefined,
  { maxLength, selectOptions, isYN, cancellable = false }: AskOptions = {},
): Promise<any> => {
  pauseSpinners();
  if (typeof defaultAnswer === 'boolean' || isYes(defaultAnswer) || isNo(defaultAnswer)) {
    isYN = true;
  }
  let answer;
  if (selectOptions) {
    let choices = selectOptions.map((option) => (typeof option === 'string' ? { value: option } : option));
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
      if (cancellable) {
        answer = confirmPrompt({
          message: displayText,
          default: defaultAnswer,
        });
      } else {
        answer = await confirmPrompt({
          message: displayText,
          default: defaultAnswer,
        });
      }
    } else {
      // answer = await question(`${displayText}: `);
      if (cancellable) {
        answer = input({ message: displayText, default: defaultAnswer });
      } else {
        answer = await input({ message: displayText, default: defaultAnswer });
      }
    }

    if (maxLength && typeof answer === 'string' && answer.length > maxLength) {
      if (cancellable) {
        answer = askInternal(questionText, answer, { maxLength });
      } else {
        answer = await askInternal(questionText, answer, { maxLength });
      }
    }
  }


  resumeSpinners();
  return answer;
};
