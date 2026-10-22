
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';

import { Planner } from '../../src/agent/planner';
import {
  PlannerResponseSchema,
} from '../../src/agent/schema';

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();

  return {
    ...original,
    generateObject: mockGenerateObject,
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

    mockGenerateObject.mockResolvedValue({
      object: mockPlan,
    });

    const result = await planner.plan(
      'Inspect the homepage'
    );

    expect(result).toEqual(mockPlan);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
      model: mockModel,
      schema: PlannerResponseSchema,
      })
    );
  });

  it('rejects invalid plans', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        thought: 'Invalid navigation',
        actions: [
          {
            type: 'navigate_to_allowlisted_path',
            path: '/admin',
          },
        ],
      },
    });

    await expect(
      planner.plan('Navigate to admin')
    ).rejects.toThrow();
  });

  it('propagates model generation failures', async () => {
    mockGenerateObject.mockRejectedValue(
      new Error('AI generation failed')
    );

    await expect(
      planner.plan('Inspect homepage')
    ).rejects.toThrow('AI generation failed');
  });
  it('returns a valid blocked response', async () => {
  const refusal = {
    status: 'blocked',
    reason: 'The requested route is not allowlisted',
    actions: [],
  };

  mockGenerateObject.mockResolvedValueOnce({
    object: refusal,
  });

  const result = await planner.plan(
    'Navigate to /admin'
  );

  expect(result).toEqual(refusal);

  expect(mockGenerateObject).toHaveBeenCalledWith(
    expect.objectContaining({
      model: mockModel,
      schema: PlannerResponseSchema,
    })
  );
});
});
