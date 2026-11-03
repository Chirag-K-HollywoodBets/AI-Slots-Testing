export const MIDSCENE_VISION_DEFAULTS = {
  baseUrl: 'http://10.6.49.95:8007/gemma/v1',
  modelName: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf',
  family: 'qwen3-vl',
  apiKey: 'dummy-key',
} as const;

export interface MidsceneModelLogInfo {
  modelName: string;
  baseUrl: string;
  family: string;
}

export interface MidsceneModelOptions {
  /** Retain legacy aliases only for the standalone read-only inspector. */
  allowLegacyLlmAliases?: boolean;
}

export function configureMidsceneModel(
  env: NodeJS.ProcessEnv = process.env,
  options: MidsceneModelOptions = {},
): MidsceneModelLogInfo {
  const legacy = options.allowLegacyLlmAliases === true;
  const baseUrl = env.MIDSCENE_MODEL_BASE_URL?.trim()
    || (legacy ? env.LLM_URL?.trim() : undefined)
    || MIDSCENE_VISION_DEFAULTS.baseUrl;
  const modelName = env.MIDSCENE_MODEL_NAME?.trim()
    || (legacy ? env.LLM_MODEL?.trim() : undefined)
    || MIDSCENE_VISION_DEFAULTS.modelName;
  const family = env.MIDSCENE_MODEL_FAMILY?.trim() || MIDSCENE_VISION_DEFAULTS.family;
  const apiKey = env.MIDSCENE_MODEL_API_KEY?.trim()
    || (legacy ? env.LLM_API_KEY?.trim() : undefined)
    || MIDSCENE_VISION_DEFAULTS.apiKey;

  env.MIDSCENE_MODEL_BASE_URL = baseUrl;
  env.MIDSCENE_MODEL_NAME = modelName;
  env.MIDSCENE_MODEL_FAMILY = family;
  env.MIDSCENE_MODEL_API_KEY = apiKey;

  // Deliberately exclude the API key from the returned/loggable metadata.
  return { baseUrl, modelName, family };
}

export function logMidsceneModelConfig(
  config: MidsceneModelLogInfo,
  apiKey = process.env.MIDSCENE_MODEL_API_KEY,
  logger: (message: string) => void = (message) => console.log(message),
): void {
  const message = `[MIDSCENE_MODEL] ${JSON.stringify(config)}`;
  logger(apiKey ? message.replaceAll(apiKey, '[REDACTED]') : message);
}
