// Read-only polling: never select odds or submit while the page is loading.
export async function waitForBetslip<T extends { visible: boolean }>(
  read: () => Promise<T>,
  timeoutMs = 30_000,
  pollMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await read();
    if (snapshot.visible) return snapshot;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('SPORTS_PAGE_NOT_READY');
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}
