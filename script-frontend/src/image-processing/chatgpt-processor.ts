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
  manufacturer?: string;
  brand?: string;
  setName?: string;
  year?: string;
  parallel?: string;
  insert?: string;
  team?: string;
  cardNumber?: string;
  front?: string;
  back?: string;
  error?: string;
  file?: string;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class ChatGPTProcessor {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async processImages(imagePaths: string[]): Promise<CardInfo[]> {
    
  const { showSpinner, log } = useSpinners('chatGPT', chalk.cyan);
  const { update, finish, error } = showSpinner('chatGPT', 'Processing Cards with ChatGPT');
  const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You'll see several photos of trading cards. For each photo, extract all cards as JSON objects matching this interface:  {
                    name?: string;
                    manufacturer?: string;
                    brand?: string;
                    setName?: string;
                    year?: string;
                    parallel?: string;
                    insert?: string;
                    team?: string;
                    cardNumber?: string;
                    front?: string;
                    back?: string;
                    error?: string;
                  }
                  Return a JSON array of these objects. 
                  Think out loud.
                  There should only be one object per card and one array of objects, no nested arrays. 
                  The front and back properties should be the file name of the image.                   
                  When you see a new card, add it to the array. If you see a card that is already in the array, merge the data into a single object.
                  
                  As an example a card from the insert set Virtuosic Vibrations from 2022 Bowman Chrome would have the following JSON values (along with specifics about player, team, etc):
                    {
                      manufacturer: 'Topps',
                      brand: 'Bowman',
                      setName: 'Bowman Chrome',
                      year: '2022',
                      insert: 'Virtuosic Vibrations',
                    }
                  `,
          },
          // Add each image as a separate image_url entry:
          ...imagePaths.map(imagePath => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(imagePath, { encoding: "base64" })}` }
          }))
        ]
      }
    ];
    const stream = await openai.chat.completions.create({
      // model: "gpt-4o-mini",                      // supports vision
      model: "gpt-4.1",
      // max_tokens: 512,                           // tweak as needed
      temperature: 0,                            // deterministic
      messages: messages,
      stream: true,
    });
    
    let jsonString = '';
    let insideJson = false;
    let bracketBalance = 0;
    let commentaryBuffer = ''; // Buffer for accumulating commentary

    for await (const chunk of stream) {
      const current = chunk.choices[0]?.delta?.content || "";

      for (const char of current) {
        if (!insideJson) {
          if (char === '[') {
            // Starting JSON - flush any remaining commentary line
            if (commentaryBuffer.trim()) {
              log(commentaryBuffer.trim());
            }
            commentaryBuffer = ''; // Reset buffer
            insideJson = true;
            bracketBalance = 1;
            jsonString += char;
          } else {
            // Accumulate commentary character
            commentaryBuffer += char;

            // If newline encountered, log the buffered line
            if (char === '\n') {
              if (commentaryBuffer.trim()) { // Avoid logging empty lines
                  log(commentaryBuffer.trim());
              }
              commentaryBuffer = ''; // Reset buffer for the next line
            }
          }
        } else {
          // Inside JSON
          jsonString += char;
          if (char === '[') bracketBalance++;
          if (char === ']') bracketBalance--;
          if (bracketBalance === 0) {
            // Finished JSON
            insideJson = false;
            // Reset commentary buffer for any text *after* JSON
            commentaryBuffer = '';
          }
        }
      }
    }

    // Log any final remaining commentary after the stream ends
    if (commentaryBuffer.trim()) {
      log(commentaryBuffer.trim());
    }

    // Final JSON parsing (with error handling)
    if (!jsonString) {
      log('No JSON content found in the response.');
      return [];
    }
    log(`jsonString: ${jsonString}`); // Log before parsing for debugging
    try {
      // Add basic validation: must start with [ and end with ]
      if (!jsonString.startsWith('[') || !jsonString.endsWith(']')) {
         throw new Error("JSON string does not start/end with brackets");
      }
      return <CardInfo[]>JSON.parse(jsonString);
    } catch (parseError: any) {
      log(`Error parsing JSON: ${parseError.message}`);
      log(`Invalid JSON string received: ${jsonString}`);
      return []; // Return empty array or throw an error
    }
  }
}
