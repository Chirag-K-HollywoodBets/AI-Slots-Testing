import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { ActionSchema, PlanSchema, ALLOWED_PATHS } from '../../src/agent/schema.js';

describe('Agent Schema Validation', () => {
  describe('ActionSchema', () => {
    it('should validate get_page_info', () => {
      const action = { type: 'get_page_info' };
      assert.deepStrictEqual(ActionSchema.parse(action), action);
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
});
