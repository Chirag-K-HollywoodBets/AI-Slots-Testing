import { beforeEach, describe, expect, it, vi } from 'vitest';
const { stat, readFile } = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat, readFile }));
import { readFixtureSnapshot } from '../../src/agent/sports-fixture-source';

const observed = { source: 'read-only-feed-cache', observedAt: 1000, fixtures: [
  { id: 'fixture-1', home: 'Man City', away: 'Brighton', competition: 'premier-league', kickoff: '2026-10-31T17:00:00Z' },
] };

describe('optional read-only fixture cache', () => {
  beforeEach(() => {
    stat.mockReset().mockResolvedValue({ isFile: () => true, size: 500 });
    readFile.mockReset().mockResolvedValue(JSON.stringify(observed));
  });

  it('uses a fresh validated snapshot without network access or browser navigation', async () => {
    expect(await readFixtureSnapshot('fixtures.json', 1000)).toEqual(observed);
    expect(readFile).toHaveBeenCalledWith('fixtures.json', expect.objectContaining({ encoding: 'utf8' }));
  });

  it('treats an unconfigured source as unavailable without reading files', async () => {
    expect(await readFixtureSnapshot(undefined, 1000)).toBeNull();
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('treats an unreadable fixture source as unavailable', async () => {
    stat.mockRejectedValue(new Error('unavailable'));
    expect(await readFixtureSnapshot('missing.json', 1000)).toBeNull();
  });

  it.each(['not json', '{"fixtures":[]}', JSON.stringify({ ...observed, observedAt: 1001 })])('rejects malformed or future observations', async (text) => {
    readFile.mockResolvedValue(text);
    expect(await readFixtureSnapshot('fixtures.json', 1000)).toBeNull();
  });

  it('rejects stale snapshots and duplicate fixture identifiers', async () => {
    expect(await readFixtureSnapshot('fixtures.json', 301001)).toBeNull();
    readFile.mockResolvedValue(JSON.stringify({ ...observed, fixtures: [...observed.fixtures, ...observed.fixtures] }));
    expect(await readFixtureSnapshot('fixtures.json', 1000)).toBeNull();
  });

  it('does not read oversized files', async () => {
    stat.mockResolvedValue({ isFile: () => true, size: 1_000_001 });
    expect(await readFixtureSnapshot('fixtures.json', 1000)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('bounds a stalled source read and returns unavailable', async () => {
    vi.useFakeTimers();
    try {
      stat.mockImplementation(() => new Promise(() => {}));
      const result = readFixtureSnapshot('fixtures.json', 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
