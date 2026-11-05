
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';

import { Planner } from '../../src/agent/planner';
const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();

  return {
    ...original,
    generateText: mockGenerateText,
  };
});

describe('Planner', () => {
  const mockModel = {
    specificationVersion: 'v2',
    provider: 'test-provider',
    modelId: 'test-model',
  };

  const planner = new Planner({
    baseUrl: 'http://localhost:8080/v1',
    modelName: 'test-model',
    apiKey: 'test-key',
    customModel: mockModel,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a valid plan', async () => {
    const mockPlan = {
      thought: 'Inspect the homepage',
      actions: [
        {
          type: 'get_page_info',
        },
        {
          type: 'check_visible',
          selector: 'body',
        },
      ],
    };

    mockGenerateText.mockResolvedValue({
      text: JSON.stringify(mockPlan),
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      response: { modelId: 'reported-model-id' },
    });

    const result = await planner.plan(
      'Inspect the homepage'
    );

    expect(result).toEqual({ ...mockPlan, usage: {
      source: 'reported', model: 'reported-model-id', reportedModel: 'reported-model-id', inputTokens: 12, outputTokens: 8, totalTokens: 20,
    } });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
      model: mockModel,
      system: expect.any(String),
      prompt: 'Inspect the homepage',
      })
    );
  });

  it('omits usage when the provider does not return metadata', async () => {
    const object = { thought: 'Inspect', actions: [{ type: 'get_page_info' }] };
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify(object) });
    expect(await planner.plan('Inspect')).toEqual(object);
  });

  it('records a provider-reported model even when token counts are omitted', async () => {
    const object = { thought: 'Inspect', actions: [{ type: 'get_page_info' }] };
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify(object), response: { modelId: 'actual-model' } });
    expect(await planner.plan('Inspect')).toEqual({ ...object, usage: {
      source: 'reported', model: 'actual-model', reportedModel: 'actual-model',
    } });
  });

  it('ignores malformed usage fields without failing planning', async () => {
    const object = { thought: 'Inspect', actions: [{ type: 'get_page_info' }] };
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(object),
      usage: { inputTokens: 12, outputTokens: -1, totalTokens: 7.5, secret: 'private' },
    });
    expect(await planner.plan('Inspect')).toEqual({
      ...object, usage: { source: 'reported', model: 'test-model', inputTokens: 12 },
    });
  });

  it('rejects invalid plans', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        thought: 'Invalid navigation',
        actions: [
          {
            type: 'navigate_to_allowlisted_path',
            path: '/admin',
          },
        ],
      }),
    });

    await expect(
      planner.plan('Navigate to admin')
    ).rejects.toThrow();
  });

  it('propagates model generation failures', async () => {
    mockGenerateText.mockRejectedValue(
      new Error('AI generation failed')
    );

    await expect(
      planner.plan('Inspect homepage')
    ).rejects.toThrow('AI generation failed');
  });

  it('interprets clarification separately from executable planning and supplies the saved unknown fields', async () => {
    const pending = { selections: [{ team: 'Arsenal', opponent: null }], competition: null, market: 'match-winner', stakeCents: null };
    const interpretation = { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: { value: 'Chelsea', evidence: 'Chelsea' } }],
    } };
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify(interpretation) });
    const result = await planner.interpretSportsMessage('Chelsea', pending);
    expect(result.interpretation).toEqual(interpretation);
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: JSON.stringify({ pending, message: 'Chelsea', outstandingClarification: null, recentContext: [] }),
    }));
    expect(result).not.toHaveProperty('actions');
    expect(pending.stakeCents).toBeNull();
  });

  it('rejects action plans or invented interpretation fields from the conversation interpreter', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify({
      kind: 'new_request', updates: { stakeCents: 1000 },
    }) });
    await expect(planner.interpretSportsMessage('Prepare Arsenal', null)).rejects.toThrow();
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify({
      thought: 'Prepare', actions: [{ type: 'get_page_info' }],
    }) });
    await expect(planner.interpretSportsMessage('Prepare Arsenal', null)).rejects.toThrow();
  });

  it('continues to return existing complete slot plans', async () => {
    const plan = { thought: 'Play slots', actions: [
      { type: 'open_game', game: 'games-in-olympus' },
      { type: 'play_slot', game: 'games-in-olympus', spins: 10, stake: 0.2 },
    ] };
    mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify(plan) });
    expect(await planner.plan('Log in, open Games in Olympus and play 10 spins at R0.20')).toEqual(plan);
  });
  it('returns a valid blocked response', async () => {
  const refusal = {
    status: 'blocked',
    reason: 'The requested route is not allowlisted',
    actions: [],
  };

  mockGenerateText.mockResolvedValueOnce({
    text: JSON.stringify(refusal),
  });

  const result = await planner.plan(
    'Navigate to /admin'
  );

  expect(result).toEqual(refusal);

  expect(mockGenerateText).toHaveBeenCalledWith(
    expect.objectContaining({
      model: mockModel,
      system: expect.any(String),
    })
  );
});
});
