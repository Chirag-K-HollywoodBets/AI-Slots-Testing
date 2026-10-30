import { describe, expect, it } from 'vitest';
import { classifyMidsceneError } from '../../scripts/midscene/inspect-olympus';

describe('Midscene VLM readiness/error classification', () => {
  it('reports missing endpoint or model ID as unavailable', () => {
    const config = (env: Record<string, string | undefined>) => Boolean(env.MIDSCENE_MODEL_BASE_URL && env.MIDSCENE_MODEL_NAME);
    expect(config({ MIDSCENE_MODEL_BASE_URL: 'http://localhost:8000/v1' })).toBe(false);
    expect(config({ MIDSCENE_MODEL_NAME: 'vision-model' })).toBe(false);
  });

  it('identifies endpoints that do not support image input', () => {
    expect(classifyMidsceneError(new Error('image input is not supported'))).toBe('MODEL_IMAGE_INPUT_UNSUPPORTED');
    expect(classifyMidsceneError(new Error('vision is not supported for this model'))).toBe('MODEL_IMAGE_INPUT_UNSUPPORTED');
  });

  it('identifies unavailable model endpoints', () => {
    expect(classifyMidsceneError(new Error('fetch failed: ECONNREFUSED'))).toBe('MODEL_UNAVAILABLE');
  });
});
