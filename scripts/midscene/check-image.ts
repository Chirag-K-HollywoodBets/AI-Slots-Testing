import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const requiredEnvironment = [
  'MIDSCENE_MODEL_BASE_URL',
  'MIDSCENE_MODEL_API_KEY',
  'MIDSCENE_MODEL_NAME',
  'MIDSCENE_MODEL_FAMILY',
] as const;

function getConfiguration(): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  const missing = requiredEnvironment.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const baseUrl = process.env.MIDSCENE_MODEL_BASE_URL!.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) {
    throw new Error('MIDSCENE_MODEL_BASE_URL must end in /v1.');
  }

  return {
    baseUrl,
    apiKey: process.env.MIDSCENE_MODEL_API_KEY!,
    model: process.env.MIDSCENE_MODEL_NAME!,
  };
}

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) {
    throw new Error('Usage: tsx --env-file=.env scripts/midscene/check-image.ts <local.png>');
  }

  const { baseUrl, apiKey, model } = getConfiguration();
  const extension = extname(imagePath).toLowerCase();
  const mimeType = extension === '.png' ? 'image/png'
    : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
      : extension === '.webp' ? 'image/webp' : null;
  if (!mimeType) throw new Error('Image must have a .png, .jpg, .jpeg, or .webp extension.');

  const image = await readFile(resolve(imagePath));
  const imageDataUrl = `data:${mimeType};base64,${image.toString('base64')}`;
  const endpoint = `${baseUrl}/chat/completions`;

  const startedAt = performance.now();
  let response: Response | undefined;
  let responseBody = '';
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    responseBody = await response.text();
  } finally {
    console.log(`Latency: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
  }

  if (!response?.ok) {
    if (!response) throw new Error('The request did not return an HTTP response.');
    console.error(`HTTP error: ${response.status} ${response.statusText}`);
    console.error(`Response body: ${responseBody}`);
    process.exitCode = 1;
    return;
  }

  try {
    const payload = JSON.parse(responseBody) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content
      : content?.map((part) => part.text ?? '').join('');
    if (!text) throw new Error('Response did not contain choices[0].message.content.');
    console.log(`Response: ${text}`);
  } catch (error) {
    console.error(`Could not read response text: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Response body: ${responseBody}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
