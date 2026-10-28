import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeSlotPlan } = require('../../chat/slot-summary.cjs') as {
  describeSlotPlan: (spin: { game: string; spins: number; stake: number }) => string;
};

describe('slot confirmation summary', () => {
  it('shows canonical game, exact spin stake, and integer-cent maximum total', () => {
    expect(describeSlotPlan({ game: 'games-in-olympus', spins: 3, stake: 0.2 }))
      .toContain('Games in Olympus, and play 3 spin(s) at R0.20 (up to R0.60 staked).');
  });
});
