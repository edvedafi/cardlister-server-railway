import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync } from 'fs';
import { useSpinners } from '../utils/spinners';
import chalk from 'chalk';

const { showSpinner, log } = useSpinners('chatGPT', chalk.blueBright);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptConfig = JSON.parse(
  readFileSync(path.join(__dirname, 'chatgpt-prompt.json'), 'utf8')
);

export interface CardInfo {
  name?: string;
  brand?: string;
  setName?: string;
  year?: string;
  parallel?: string;
  insert?: string;
  team?: string;
  cardNumber?: string;
  front?: boolean;
  back?: boolean;
  error?: string;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class ChatGPTProcessor {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async processImage(imagePath: string): Promise<CardInfo[]> {

    // 1 · load & base64‑encode the photo (must be < 20 MB after encoding)
    const imgB64 = fs.readFileSync(imagePath, { encoding: "base64" });
    
    // 2 · ask GPT‑4o (or gpt‑4.1‑mini) to list every card it sees
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",                      // supports vision
      max_tokens: 512,                           // tweak as needed
      temperature: 0,                            // deterministic
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `You'll see a photo of several trading cards.
                  For each card, extract the following fields as JSON objects matching this interface:

                  {
                    name?: string;
                    brand?: string;
                    setName?: string;
                    year?: string;
                    parallel?: string;
                    insert?: string;
                    team?: string;
                    cardNumber?: string;
                    front?: boolean;
                    back?: boolean;
                    error?: string;
                  }

                  Return a JSON array of these objects. Output only the JSON—no markdown, no explanations, no extra text.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imgB64}` },
            },
          ],
        },
      ],
    });
    
    if (!completion.choices[0].message.content) {
      return [];
    }
    console.log(completion.choices[0].message.content);
    return <CardInfo[]>JSON.parse(completion.choices[0].message.content);
  }

  async processImages(imagePaths: string[]): Promise<CardInfo[]> {
    const results: CardInfo[] = [];
    for (const imagePath of imagePaths) {
      const result = await this.processImage(imagePath);
      results.push(...result);
    }
    return results;
  }
}
