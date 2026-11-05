import { describe, expect, it, vi } from 'vitest';
import { checkMidsceneReadiness } from '../../src/agent/midscene-readiness';

const config = {
  baseUrl: 'http://vision.example/gemma/v1',
  modelName: 'vision-model',
  apiKey: 'test-api-key',
  modelsTimeoutMs: 100,
  imageTimeoutMs: 100,
};

describe('Midscene image readiness gate', () => {
  it('passes only after the model is listed and an image completion returns content', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'vision-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }));

    const result = await checkMidsceneReadiness({ ...config, fetchImpl: fetchMock });

    expect(result).toEqual({
      ready: true,
      model: 'vision-model',
      modelsEndpoint: 'http://vision.example/gemma/v1/models',
      imageEndpoint: 'http://vision.example/gemma/v1/chat/completions',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('data:image/png;base64,');
  });

  it('fails closed on a missing model and does not send an image request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), { status: 200 }));

    const result = await checkMidsceneReadiness({ ...config, fetchImpl: fetchMock });

    expect(result).toMatchObject({ ready: false, code: 'MODEL_UNAVAILABLE', stage: 'model-list' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails when the listed model rejects image input', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'vision-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('vision unsupported test-api-key', { status: 400, statusText: 'Bad Request' }));

    const result = await checkMidsceneReadiness({ ...config, fetchImpl: fetchMock });

    expect(result).toMatchObject({ ready: false, code: 'MODEL_UNAVAILABLE', stage: 'image-input' });
    expect(result.ready).toBe(false);
    if (result.ready) throw new Error('Expected image readiness to fail.');
    expect(result.reason).toContain('HTTP 400');
    expect(result.reason).not.toContain(config.apiKey);
  });

  it('fails closed when the image request returns no affirmative acknowledgement', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'vision-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot process images.' } }] }), { status: 200 }));

    const result = await checkMidsceneReadiness({ ...config, fetchImpl: fetchMock });

    expect(result).toEqual({
      ready: false,
      code: 'MODEL_UNAVAILABLE',
      stage: 'image-input',
      reason: 'Image request returned no valid OK acknowledgement.',
    });
  });
});
