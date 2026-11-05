import { configureMidsceneModel } from '../../src/agent/midscene-model';
import { checkMidsceneReadiness } from '../../src/agent/midscene-readiness';

async function main(): Promise<void> {
  // Match the runner's configuration: explicit Midscene settings and defaults.
  const model = configureMidsceneModel();
  const result = await checkMidsceneReadiness({
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    apiKey: process.env.MIDSCENE_MODEL_API_KEY,
  });
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const apiKey = process.env.MIDSCENE_MODEL_API_KEY;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.log(JSON.stringify({
    ready: false,
    code: 'MODEL_UNAVAILABLE',
    reason: apiKey ? message.replaceAll(apiKey, '[REDACTED]') : message,
  }));
  process.exitCode = 1;
});
