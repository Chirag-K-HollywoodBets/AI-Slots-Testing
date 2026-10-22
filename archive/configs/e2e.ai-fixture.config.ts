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
      maxInputTokens: 4096,
      maxObservationBytes: 8192,
      maxSteps: 1,
      maxModelCalls: 2,
      system: 'You are a concise QA agent. Inspect only the visible page and perform the requested action.',
    },
  },
  targets: [{
    name: 'ai-fixture',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:4173',
      command: {
        executable: 'node',
        args: ['tests/fixture-server.mjs'],
        startupTimeout: 10000,
      },
    },
  }],
} satisfies E2EConfig;
