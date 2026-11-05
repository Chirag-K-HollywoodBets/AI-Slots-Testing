import { describe, expect, it } from 'vitest';
import { classifyMidsceneError } from '../../scripts/midscene/inspect-olympus';
import {
  configureMidsceneModel,
  buildMidsceneModelsUrl,
  logMidsceneModelConfig,
  MIDSCENE_VISION_DEFAULTS,
  validateMidsceneModelsPayload,
} from '../../src/agent/midscene-model';

describe('Midscene VLM readiness/error classification', () => {
  it.each([
    ['base without trailing slash', 'http://vision.example', 'http://vision.example/models'],
    ['base with trailing slash', 'http://vision.example/', 'http://vision.example/models'],
    ['base path', 'http://vision.example/gemma/v1', 'http://vision.example/gemma/v1/models'],
  ])('joins the models path for a %s', (_label, baseUrl, expected) => {
    expect(buildMidsceneModelsUrl(baseUrl).href).toBe(expected);
  });

  it.each([
    ['invalid JSON', '{not-json}', 'Response body is not valid JSON.'],
    ['missing data array', '{"models":[]}', 'Response JSON does not contain a data array.'],
  ])('fails closed for %s', (_label, payload, reason) => {
    expect(validateMidsceneModelsPayload(payload, 'vision-model')).toEqual({ available: false, reason });
  });

  it('accepts a data array containing the configured model ID', () => {
    expect(validateMidsceneModelsPayload('{"data":[{"id":"vision-model"}]}', 'vision-model'))
      .toEqual({ available: true });
  });

  it('rejects a data array containing only a different model ID', () => {
    expect(validateMidsceneModelsPayload('{"data":[{"id":"another-model"}]}', 'vision-model'))
      .toEqual({ available: false, reason: 'Configured model ID was not found in the response data.' });
  });

  it('prefers explicit MIDSCENE variables over legacy aliases', () => {
    const env: NodeJS.ProcessEnv = {
      MIDSCENE_MODEL_BASE_URL: 'http://vision.example/v1',
      MIDSCENE_MODEL_NAME: 'vision-explicit',
      MIDSCENE_MODEL_FAMILY: 'qwen3-vl-explicit',
      MIDSCENE_MODEL_API_KEY: 'vision-key',
      LLM_URL: 'http://planner.example/v1',
      LLM_MODEL: 'text-planner',
      LLM_API_KEY: 'planner-key',
    };

    const config = configureMidsceneModel(env, { allowLegacyLlmAliases: true });
    expect(config).toEqual({
      baseUrl: 'http://vision.example/v1',
      modelName: 'vision-explicit',
      family: 'qwen3-vl-explicit',
    });
    expect(env.MIDSCENE_MODEL_API_KEY).toBe('vision-key');
  });

  it('does not use the text planner model in runner mode', () => {
    const env: NodeJS.ProcessEnv = { LLM_MODEL: 'Qwen3.8-27B-text-planner' };
    const config = configureMidsceneModel(env);

    expect(config.modelName).toBe(MIDSCENE_VISION_DEFAULTS.modelName);
    expect(env.MIDSCENE_MODEL_NAME).toBe(MIDSCENE_VISION_DEFAULTS.modelName);
  });

  it('uses the existing Qwen3-VL defaults when no model variables are set', () => {
    const env: NodeJS.ProcessEnv = {};
    const config = configureMidsceneModel(env);

    expect(config).toEqual({
      baseUrl: MIDSCENE_VISION_DEFAULTS.baseUrl,
      modelName: MIDSCENE_VISION_DEFAULTS.modelName,
      family: 'qwen3-vl',
    });
    expect(env.MIDSCENE_MODEL_API_KEY).toBe(MIDSCENE_VISION_DEFAULTS.apiKey);
  });

  it('never includes the API key in Midscene model log output', () => {
    const apiKey = 'midscene-secret-test-key';
    const env: NodeJS.ProcessEnv = {
      MIDSCENE_MODEL_BASE_URL: 'http://vision.example/v1',
      MIDSCENE_MODEL_NAME: 'vision-explicit',
      MIDSCENE_MODEL_API_KEY: apiKey,
    };
    const config = configureMidsceneModel(env);
    const output: string[] = [];

    logMidsceneModelConfig(config, env.MIDSCENE_MODEL_API_KEY, (message) => output.push(message));

    expect(output.join('\n')).toContain('vision-explicit');
    expect(output.join('\n')).not.toContain(apiKey);
  });

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
