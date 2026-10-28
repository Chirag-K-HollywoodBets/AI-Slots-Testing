import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withUsage, pendingPlan } = require('../../chat/usage.cjs') as {
  withUsage: (response: Record<string, unknown>, usage?: Record<string, unknown>) => Record<string, unknown>;
  pendingPlan: (plan: unknown, usage: Record<string, unknown>, expires: number) => { plan: unknown; usage: Record<string, unknown>; expires: number };
};

describe('chat token usage propagation', () => {
  const usage = { source: 'reported', model: 'test-model', inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  it('keeps planning usage on the confirmation response and pending run', () => {
    const plan = { actions: [{ type: 'play_slot' }] };
    const pending = pendingPlan(plan, usage, 123);
    const confirmation = withUsage({ status: 'CONFIRM', planId: 'id' }, pending.usage);
    expect(pending).toEqual({ plan, usage, expires: 123 });
    expect(confirmation).toEqual({ status: 'CONFIRM', planId: 'id', usage });
  });

  it('adds planning usage to the completed run response', () => {
    expect(withUsage({ status: 'PASS', success: true, actions: [] }, usage)).toEqual({
      status: 'PASS', success: true, actions: [], usage,
    });
  });
});
