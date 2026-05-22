import OpenAI from 'openai';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = process.env.IMAGES_DIR || join(__dir, '../../client/assets/generated');

mkdirSync(IMAGES_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// For providers that don't support b64, fall back to URL
export async function generatePixelArtImage(prompt, submissionId) {
  if (!process.env.OPENAI_API_KEY) {
    // Return a placeholder when no key is configured
    return { url: null, placeholder: true };
  }

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
    quality: 'standard',
    style: 'vivid',
  });

  const b64 = response.data[0].b64_json;
  const filename = `${submissionId}.png`;
  const filepath = join(IMAGES_DIR, filename);
  writeFileSync(filepath, Buffer.from(b64, 'base64'));

  return { url: `/assets/generated/${filename}`, placeholder: false };
}
