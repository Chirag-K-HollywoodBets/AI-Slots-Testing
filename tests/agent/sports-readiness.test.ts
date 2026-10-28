import { afterEach, expect, it, vi } from 'vitest';
import { waitForBetslip } from '../../src/agent/sports-readiness';

afterEach(() => vi.useRealTimers());

it('waits for a delayed betslip without changing its contents', async () => {
  vi.useFakeTimers();
  const loaded = { visible: true, empty: false };
  const read = vi.fn().mockResolvedValueOnce({ visible: false }).mockResolvedValue(loaded);
  const pending = waitForBetslip(read);
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toEqual(loaded);
  expect(read).toHaveBeenCalledTimes(2);
});

it('stops when the betslip remains missing', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ visible: false });
  const result = expect(waitForBetslip(read, 500)).rejects.toThrow('SPORTS_PAGE_NOT_READY');
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(read).toHaveBeenCalledTimes(3);
});

it('propagates read errors without retrying browser operations', async () => {
  const read = vi.fn().mockRejectedValue(new Error('browser disconnected'));
  await expect(waitForBetslip(read)).rejects.toThrow('browser disconnected');
  expect(read).toHaveBeenCalledTimes(1);
});
