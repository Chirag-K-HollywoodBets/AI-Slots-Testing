import {
  buildMidsceneEndpointUrl,
  buildMidsceneModelsUrl,
  validateMidsceneModelsPayload,
} from './midscene-model';

// A one-pixel PNG keeps the readiness request small and avoids reading account UI.
const READINESS_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/4c8AAAAASUVORK5CYII=';

export interface MidsceneReadinessConfig {
  baseUrl: string;
  modelName: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  modelsTimeoutMs?: number;
  imageTimeoutMs?: number;
}

export type MidsceneReadinessResult =
  | { ready: true; model: string; modelsEndpoint: string; imageEndpoint: string }
  | { ready: false; code: 'MODEL_UNAVAILABLE'; stage: 'model-list' | 'image-input'; reason: string };

function redactApiKey(value: string, apiKey?: string): string {
  return apiKey ? value.replaceAll(apiKey, '[REDACTED]') : value;
}

function errorReason(error: unknown, apiKey?: string): string {
  if (!(error instanceof Error)) return redactApiKey(String(error), apiKey);
  const cause = error.cause instanceof Error
    ? `${error.cause.name}: ${error.cause.message}`
    : error.cause === undefined ? '' : String(error.cause);
  return redactApiKey(`${error.name}: ${error.message}${cause ? `; cause: ${cause}` : ''}`, apiKey);
}

async function responseFailure(response: Response, apiKey?: string): Promise<string> {
  const body = redactApiKey(await response.text(), apiKey).slice(0, 300);
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${body}`;
}

function hasImageAcknowledgement(payloadText: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object' || !('choices' in payload) || !Array.isArray(payload.choices)) return false;
  const firstChoice = payload.choices[0];
  if (!firstChoice || typeof firstChoice !== 'object' || !('message' in firstChoice)) return false;
  const message = firstChoice.message;
  if (!message || typeof message !== 'object' || !('content' in message)) return false;
  const content = message.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => part && typeof part === 'object' && 'text' in part
        && typeof part.text === 'string' ? part.text : '').join(' ')
      : '';
  return /\bOK\b/i.test(text);
}

/** Check the configured model listing, then prove that it accepts an image request. */
export async function checkMidsceneReadiness(config: MidsceneReadinessConfig): Promise<MidsceneReadinessResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  let stage: 'model-list' | 'image-input' = 'model-list';

  try {
    const modelsEndpoint = buildMidsceneModelsUrl(config.baseUrl);
    const imageEndpoint = buildMidsceneEndpointUrl(config.baseUrl, 'chat/completions');
    const authorization: Record<string, string> = {};
    if (config.apiKey) authorization.Authorization = `Bearer ${config.apiKey}`;
    const modelsResponse = await fetchImpl(modelsEndpoint, {
      headers: authorization,
      signal: AbortSignal.timeout(config.modelsTimeoutMs ?? 5_000),
    });
    if (!modelsResponse.ok) {
      return { ready: false, code: 'MODEL_UNAVAILABLE', stage: 'model-list', reason: await responseFailure(modelsResponse, config.apiKey) };
    }
    const modelCheck = validateMidsceneModelsPayload(await modelsResponse.text(), config.modelName);
    if (!modelCheck.available) {
      return { ready: false, code: 'MODEL_UNAVAILABLE', stage: 'model-list', reason: modelCheck.reason ?? 'Model list validation failed.' };
    }

    stage = 'image-input';
    const imageResponse = await fetchImpl(imageEndpoint, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.modelName,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Process this image input and reply with exactly OK.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${READINESS_PNG_BASE64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(config.imageTimeoutMs ?? 120_000),
    });
    if (!imageResponse.ok) {
      return { ready: false, code: 'MODEL_UNAVAILABLE', stage: 'image-input', reason: await responseFailure(imageResponse, config.apiKey) };
    }
    if (!hasImageAcknowledgement(await imageResponse.text())) {
      return { ready: false, code: 'MODEL_UNAVAILABLE', stage: 'image-input', reason: 'Image request returned no valid OK acknowledgement.' };
    }

    return { ready: true, model: config.modelName, modelsEndpoint: modelsEndpoint.href, imageEndpoint: imageEndpoint.href };
  } catch (error) {
    return {
      ready: false,
      code: 'MODEL_UNAVAILABLE',
      stage,
      reason: errorReason(error, config.apiKey),
    };
  }
}
