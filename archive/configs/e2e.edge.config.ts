import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export default {
  agents: {
    default: {
      model: createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: 'http://10.6.49.95:8007/gemma/v1',
      }).chatModel('Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf'),
    },
  },
  targets: [{
    engine: web({
      connect: {
        cdpEndpoint: async () => 'http://127.0.0.1:9222',
      },
    }),
    app: {
      url: 'https://www.hollywoodbets.net/',
    },
  }],
} satisfies E2EConfig;
