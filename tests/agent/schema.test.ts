import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  ActionSchema,
  PlanSchema,
  ALLOWED_PATHS,
  isSportsWagerPlan,
  isWagerPlan,
  needsAuth,
  GAME_CATALOGUE,
  resolveGameName,
  validateSlotStake,
} from '../../src/agent/schema.js';
import { validateSpinRequest } from '../../src/agent/adapters/e2e-browser.js';

describe('Agent Schema Validation', () => {
  describe('verified slot catalogue', () => {
    it('resolves only the exact verified game name', () => {
      assert.equal(resolveGameName(' Games in Olympus '), 'games-in-olympus');
      assert.equal(resolveGameName('Gates of Olympus'), null);
      assert.equal(resolveGameName('Unknown Slots'), null);
      assert.equal(GAME_CATALOGUE['games-in-olympus'].route, '/lobby/top-games/#/g/games-in-olympus');
    });

    it('accepts only the verified stake amount without rounding', () => {
      assert.equal(validateSlotStake('games-in-olympus', 0.2), true);
      assert.equal(validateSlotStake('games-in-olympus', 0.201), false);
      assert.equal(validateSlotStake('games-in-olympus', 0.21), false);
      assert.equal(validateSlotStake('unknown-game', 0.2), false);
    });

    it('requires exact stake fields, ante off, and an armed spin window', () => {
      assert.equal(validateSpinRequest('action=doSpin&c=0.01&l=20&bl=0', 0.2, true), null);
      assert.equal(validateSpinRequest('action=doSpin&c=0.01&l=20', 0.2, true), 'STAKE_UNVERIFIED');
      assert.equal(validateSpinRequest('action=doSpin&c=0.01&l=20&bl=1', 0.2, true), 'STAKE_MISMATCH');
      assert.equal(validateSpinRequest('action=doSpin&c=0.02&l=20&bl=0', 0.2, true), 'STAKE_MISMATCH');
      assert.equal(validateSpinRequest('action=doSpin&c=0.01&l=20&bl=0', 0.2, false), 'SPIN_OUTSIDE_WINDOW');
    });
  });

  describe('ActionSchema', () => {
    it('should validate get_page_info', () => {
      const action = { type: 'get_page_info' };
      assert.deepStrictEqual(ActionSchema.parse(action), action);
    });

    it('accepts explicit single and accumulator requests with integer-cent stakes under R50', () => {
      const action = {
        type: 'prepare_sports_bet',
        competition: 'premier-league',
        selections: [{ team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: 'Everton' }],
        market: 'match-winner',
        stakeCents: 5000,
        submit: false,
      };
      assert.deepStrictEqual(ActionSchema.parse(action), action);
      assert.deepStrictEqual(ActionSchema.parse({ ...action, selections: [{ team: 'Arsenal' }] }), { ...action, selections: [{ team: 'Arsenal' }] });
      assert.equal(ActionSchema.safeParse({ ...action, stakeCents: 101 }).success, true);
      assert.equal(ActionSchema.safeParse({ ...action, stakeCents: 99 }).success, false);
      assert.equal(ActionSchema.safeParse({ ...action, stakeCents: 5001 }).success, false);
      assert.equal(ActionSchema.safeParse({ ...action, stakeCents: 0 }).success, false);
      assert.equal(ActionSchema.safeParse({ ...action, selections: Array.from({ length: 10 }, () => ({ team: 'Arsenal' })) }).success, true);
      assert.equal(ActionSchema.safeParse({ ...action, selections: Array.from({ length: 11 }, () => ({ team: 'Arsenal' })) }).success, false);
      assert.equal(ActionSchema.safeParse({ ...action, selections: [{ team: '' }] }).success, false);
      assert.equal(ActionSchema.safeParse({ ...action, competition: 'champions-league' }).success, false);
    });

    it('should validate navigate_to_allowlisted_path with valid paths', () => {
      for (const path of ALLOWED_PATHS) {
        const action = { type: 'navigate_to_allowlisted_path', path };
        assert.deepStrictEqual(ActionSchema.parse(action), action);
      }
    });

    it('should validate check_visible', () => {
      const action = {
  type: 'check_visible',
  selector: '.match-list-item-container'
};
      assert.deepStrictEqual(ActionSchema.parse(action), action);
    });

    it('should validate capture_evidence', () => {
      const action = { type: 'capture_evidence', reason: 'to verify error message' };
      assert.deepStrictEqual(ActionSchema.parse(action), action);
    });

    it('should reject unknown action types', () => {
      const action = { type: 'unknown_action' };
      assert.throws(() => ActionSchema.parse(action), /Invalid discriminator value/);
    });

    it('should reject unexpected properties (strict mode)', () => {
      const action = { type: 'get_page_info', extra: 'not_allowed' };
      assert.throws(() => ActionSchema.parse(action), /Unrecognized key/);
    });

    it('should reject missing required properties', () => {
      const result = ActionSchema.safeParse({
        type: 'check_visible'
      });

      assert.equal(result.success, false);
    });
    it('should reject empty selector or reason strings', () => {
      assert.equal(
        ActionSchema.safeParse({
          type: 'check_visible',
          selector: ''
      }).success,
      false
    );

    assert.equal(
      ActionSchema.safeParse({
       type: 'capture_evidence',
       reason: ''
      }).success,
      false
    );
  });

    it('should reject disallowed paths', () => {
      const action = { type: 'navigate_to_allowlisted_path', path: '/admin' };
      assert.throws(() => ActionSchema.parse(action), /Invalid option: expected one of/);
    });

    it('should reject external URLs', () => {
      const action = { type: 'navigate_to_allowlisted_path', path: 'https://example.com' };
      assert.throws(() => ActionSchema.parse(action), /Invalid option: expected one of/);
    });

    it('should reject protocol-relative URLs', () => {
      const action = { type: 'navigate_to_allowlisted_path', path: '//example.com' };
      assert.throws(() => ActionSchema.parse(action), /Invalid option: expected one of/);
    });
  });

  describe('PlanSchema', () => {
    it('should validate a complete valid plan', () => {
  const plan = {
    thought: 'Navigate to Live Sports and verify event cards.',
    actions: [
      {
        type: 'navigate_to_allowlisted_path',
        path: '/betting/live-in-play/0/all-sports'
      },
      {
        type: 'check_visible',
        selector: '.match-list-item-container'
      }
    ]
  };

  assert.deepStrictEqual(PlanSchema.parse(plan), plan);
});

    it('requires a matching allowlisted game to be opened before its spins', () => {
      const playOnly = {
        thought: 'Play Olympus',
        actions: [{ type: 'play_slot', game: 'games-in-olympus', spins: 1, stake: 0.2 }],
      };
      assert.equal(PlanSchema.safeParse(playOnly).success, false);
    });

    it('should reject empty action arrays', () => {
      const plan = {
        thought: 'Doing nothing',
        actions: []
      };
      assert.throws(() => PlanSchema.parse(plan), /Too small: expected array to have >=1 items/);
    });

    it('should reject invalid plan summaries (thought)', () => {
  const plan = {
    thought: '',
    actions: [
      { type: 'get_page_info' }
    ]
  };

  assert.equal(
    PlanSchema.safeParse(plan).success,
    false
  );
});

    it('should reject plans with invalid actions', () => {
      const plan = {
        thought: 'Invalid action',
        actions: [{ type: 'invalid_type' }]
      };
      assert.throws(() => PlanSchema.parse(plan), /Invalid discriminator value/);
    });
  });

  describe('sports-wager routing', () => {
    it('requires the signed-in confirmation flow for sports betslips', () => {
      const plan = {
        actions: [{ type: 'prepare_sports_bet' }],
      };
      assert.equal(isSportsWagerPlan(plan), true);
      assert.equal(isWagerPlan(plan), true);
      assert.equal(needsAuth(plan), true);
    });
  });
});
