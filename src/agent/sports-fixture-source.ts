import { readFile, stat } from 'node:fs/promises';
import { usableFixtureSnapshot, type FixtureSnapshot } from './sports-team-clarification';

/** Optional application-maintained read-only cache. Never fetch or navigate. */
export async function readFixtureSnapshot(path: string | undefined, now = Date.now()): Promise<FixtureSnapshot | null> {
  if (!path) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const info = await stat(path);
        if (!info.isFile() || info.size > 1_000_000) return null;
        return usableFixtureSnapshot(JSON.parse(await readFile(path, { encoding: 'utf8', signal: controller.signal })), now);
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, 1000);
      }),
    ]);
  } catch {
    // Missing, unreadable, malformed and stale caches all mean unavailable.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
