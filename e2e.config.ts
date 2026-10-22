import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export default {
  // The endpoint serves the model id over the OpenAI chat API; pass apiKey when it needs one.
agents: {
  default: {
    model: createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: 'http://10.6.49.95:8007/gemma/v1',
    }).chatModel('Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf'),

    maxInputTokens: 49152,
    maxObservationBytes: 40000,
    maxSteps: 2,
    maxModelCalls: 2,

    system:
      'You are a concise QA agent. Use the minimum steps necessary. ' +
      'Inspect only relevant visible page content. Verify outcomes and ' +
      'do not repeat completed actions.',
  },
},
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://localhost:3000',
      // Or let the runner start the dev server:
      // command: { executable: 'npm', args: ['run', 'dev'] },
    },
  }],
} satisfies E2EConfig;
