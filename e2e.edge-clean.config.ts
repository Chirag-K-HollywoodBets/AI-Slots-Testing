import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// Used by chat/server.cjs. Expects Edge already running with
// --remote-debugging-port=9223 and a clean --user-data-dir.

export default {
  tests: ['tests/**/*.e2e.ts'],

  agents: {
    default: {
      model: createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: 'http://10.6.49.95:8007/gemma/v1',
      }).chatModel('Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf'),
    },
  },

  // Test account. Values stay on this machine; set them before starting the chat server:
  //   $env:E2E_USER_HB_TEST_USERNAME = "<cell number>"
  //   $env:E2E_USER_HB_TEST_PASSWORD = "<password>"
  // The password reaches the browser only as a Secret fill and is redacted from logs/reports.
  // Declared only when set: e2e refuses to start with an empty password, which would
  // otherwise break the read-only flows too.
  ...(process.env.E2E_USER_HB_TEST_PASSWORD
    ? {
        credentials: {
          'hb-test': {
            username: process.env.E2E_USER_HB_TEST_USERNAME ?? '',
            password: process.env.E2E_USER_HB_TEST_PASSWORD,
          },
        },
      }
    : {}),

  targets: [{
    engine: web({
      connect: {
        cdpEndpoint: async () => 'http://127.0.0.1:9223',
      },
    }),
    app: {
      url: 'https://www.hollywoodbets.net/',
    },
  }],
} satisfies E2EConfig;
