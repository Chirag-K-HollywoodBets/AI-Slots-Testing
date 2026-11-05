import { describe, expect, it } from 'vitest';
import { executePlan, type BrowserAdapter, type SuccessfulPlaySlotActionResult } from '../../src/agent/executor';
import { settleSlotObservation, type SlotObservation, type SlotSpinResult } from '../../src/agent/slot-settlement';

describe('slot executor observation settlement', () => {
  it.each([
    {
      label: 'one spin',
      before: 100,
      spins: [{ spin: 1, stake: 0.2, win: 0.5, balance: 100.3, serverFields: [{ c: 0.01, l: 20, tw: 0.5, balance: 100.3 }] }],
      expected: 100.3,
    },
    {
      label: 'three spins',
      before: 100,
      spins: [
        { spin: 1, stake: 0.2, win: 0, balance: 99.8, serverFields: [{ c: 0.01, l: 20, tw: 0, balance: 99.8 }] },
        { spin: 2, stake: 0.2, win: 0.15, balance: 99.75, serverFields: [{ c: 0.01, l: 20, tw: 0.15, balance: 99.75 }] },
        { spin: 3, stake: 0.2, win: 0.5, balance: 100.05, serverFields: [{ c: 0.01, l: 20, tw: 0.5, balance: 100.05 }] },
      ],
      expected: 100.05,
    },
  ])('extracts and settles the executor observation for $label', async ({ before, spins, expected }) => {
    const browser: BrowserAdapter = {
      getPageInfo: async () => ({ title: 'Olympus', url: 'https://example.test' }),
      navigateTo: async () => undefined,
      isVisible: async () => true,
      captureEvidence: async () => 'unused',
      openGame: async () => ({ frameSrc: 'https://game.example/frame' }),
      playSlot: async () => spins as SlotSpinResult[],
      prepareSportsBet: async () => { throw new Error('unused'); },
    };
    const execution = await executePlan({
      thought: 'Play the confirmed slot spins.',
      actions: [
        { type: 'open_game', game: 'games-in-olympus' },
        { type: 'play_slot', game: 'games-in-olympus', spins: spins.length, stake: 0.2 },
      ],
    }, browser);
    const slotResult = execution.results.find(
      (result): result is SuccessfulPlaySlotActionResult => result.action.type === 'play_slot' && result.success,
    );
    expect(slotResult).toBeDefined();
    const observation: SlotObservation = slotResult!.observation;
    const settlement = settleSlotObservation(before, observation, spins.length);

    expect(settlement.spinResults).toHaveLength(spins.length);
    expect(settlement.totalStaked).toBe(Math.round(spins.length * 0.2 * 100) / 100);
    expect(settlement.totalWon).toBe(Math.round(spins.reduce((sum, spin) => sum + spin.win, 0) * 100) / 100);
    expect(settlement.expectedBalance).toBe(expected);
    expect(settlement.expectedBalance).toBe(observation.finalBalance);
  });
});
