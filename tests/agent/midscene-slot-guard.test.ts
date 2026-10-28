import { describe, expect, it } from 'vitest';
import { isDoSpinRequest } from '../../src/agent/midscene-slot-guard';

describe('Midscene slot network guard', () => {
  it('detects doSpin in a form body', () => {
    expect(isDoSpinRequest('https://game.example/gs2c/gameService', 'action=doSpin&c=0.01&l=20&bl=0')).toBe(true);
  });

  it('detects doSpin in a JSON body even when the URL has another action', () => {
    expect(isDoSpinRequest('https://game.example/gameService?action=doInit', '{"action":"doSpin"}')).toBe(true);
  });

  it('detects doSpin in the URL query', () => {
    expect(isDoSpinRequest('https://game.example/gameService?action=doSpin', null)).toBe(true);
  });

  it('allows non-spin setup requests', () => {
    expect(isDoSpinRequest('https://game.example/gs2c/gameService', 'action=doInit&c=0.01&l=20')).toBe(false);
    expect(isDoSpinRequest('https://game.example/assets/game.js', null)).toBe(false);
  });
});
