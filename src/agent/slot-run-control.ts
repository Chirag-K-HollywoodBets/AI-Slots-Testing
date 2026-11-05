export interface OverlayDecisionInput {
  overlay: string;
  blocksSpin: boolean;
  targetInsideGuardedZone?: boolean;
  targetLabel?: string;
}

export type OverlayDecision = 'spin' | 'dismiss-prize-drops' | 'stop';

/** Fail closed: only positively identified Prize Drops OK wholly in-zone may be dismissed. */
export function decidePreSpinOverlay(input: OverlayDecisionInput): OverlayDecision {
  if (input.overlay === 'none' && !input.blocksSpin) return 'spin';
  if (input.overlay === 'prize_drops' && input.blocksSpin
    && input.targetInsideGuardedZone === true
    && (input.targetLabel ?? '').trim().toLowerCase() === 'ok') {
    return 'dismiss-prize-drops';
  }
  return 'stop';
}

export function canRetrySpin(requestsForSpin: number, retries: number, readinessPassed: boolean, stakePassed: boolean): boolean {
  return requestsForSpin === 0 && retries === 0 && readinessPassed && stakePassed;
}

export interface QuietWindowResult { responseCount: number; timedOut: boolean; triggerError?: unknown }

/** Listen before the click; only a timer that sees silence ends a normal response window. */
export function collectResponseQuietWindow<T>(
  subscribe: (listener: (response: T) => void) => () => void,
  trigger: () => Promise<void>,
  onResponse: (response: T) => Promise<void>,
  options: { firstResponseTimeoutMs: number; quietMs: number },
): Promise<QuietWindowResult> {
  return new Promise((resolve, reject) => {
    let done = false;
    let responseCount = 0;
    let triggerError: unknown;
    let firstTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let processing = Promise.resolve();
    let triggerPromise: Promise<void> | undefined;
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      if (firstTimer) clearTimeout(firstTimer);
      if (quietTimer) clearTimeout(quietTimer);
      unsubscribe();
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      void (async () => {
        if (triggerPromise) await Promise.allSettled([triggerPromise]);
        reject(error);
      })();
    };
    const finish = async (timedOut: boolean) => {
      if (done) return;
      done = true;
      cleanup();
      if (triggerPromise) await Promise.allSettled([triggerPromise]);
      try {
        await processing;
        resolve({ responseCount, timedOut: timedOut && responseCount === 0, ...(triggerError === undefined ? {} : { triggerError }) });
      } catch (error) {
        reject(error);
      }
    };
    const onEvent = (response: T) => {
      if (done) return;
      responseCount++;
      if (firstTimer) clearTimeout(firstTimer);
      firstTimer = undefined;
      if (quietTimer) clearTimeout(quietTimer);
      processing = processing.then(() => onResponse(response));
      void processing.catch(fail);
      quietTimer = setTimeout(() => { void finish(false); }, options.quietMs);
    };
    try {
      unsubscribe = subscribe(onEvent);
      firstTimer = setTimeout(() => { void finish(true); }, options.firstResponseTimeoutMs);
      triggerPromise = Promise.resolve().then(trigger);
      void triggerPromise.catch((error: unknown) => { triggerError = error; });
    } catch (error) {
      fail(error);
    }
  });
}

export interface SpinSettlementResponse {
  stake: number | null;
  anteOn: boolean | null;
  win: number | null;
  balance: number | null;
  serverFields: { c: number | null; l: number | null; tw: number | null; balance: number | null };
}

export function extractSpinSettlement(responses: SpinSettlementResponse[]) {
  const firstStakeResponse = responses.find((response) => response.stake !== null);
  if (!firstStakeResponse) throw new Error('SPIN_RESPONSE_UNRECOGNISED');
  return {
    firstStakeResponse,
    win: [...responses].reverse().find((response) => response.win !== null)?.win ?? 0,
    balance: [...responses].reverse().find((response) => response.balance !== null)?.balance ?? null,
    serverFields: responses.map((response) => response.serverFields),
  };
}

export function spinStakeFailureCode(response: SpinSettlementResponse, expectedStake: number): 'STAKE_MISMATCH' | null {
  return response.stake !== expectedStake || response.anteOn !== false ? 'STAKE_MISMATCH' : null;
}

export type SlotOverlayType = 'none' | 'win_celebration' | 'prize_drops' | 'free_spins' | 'other';

export interface WinCelebrationState { overlay: SlotOverlayType; blocksSpin: boolean }

/** Passive-only polling for a win animation; this helper has no click capability. */
export async function waitForWinCelebrationClear(
  read: () => Promise<WinCelebrationState>,
  pause: (ms: number) => Promise<void>,
  options: { intervalMs?: number; maxWaitMs?: number; initialState?: WinCelebrationState } = {},
): Promise<{ cleared: boolean; state: WinCelebrationState }> {
  const intervalMs = options.intervalMs ?? 2500;
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  let elapsed = 0;
  let state = options.initialState ?? await read();
  while (state.overlay === 'win_celebration' && elapsed < maxWaitMs) {
    const waitMs = Math.min(intervalMs, maxWaitMs - elapsed);
    await pause(waitMs);
    elapsed += waitMs;
    state = await read();
  }
  // Once the celebration itself is gone, let the full pre-spin gate classify
  // any newly visible overlay (including a dismissible Prize Drops modal).
  return { cleared: state.overlay !== 'win_celebration', state };
}

export function winCelebrationFailureCode(cleared: boolean): 'OVERLAY_BLOCKING' | null {
  return cleared ? null : 'OVERLAY_BLOCKING';
}

export function persistSpinSettlement<T>(events: T[], event: T): T[] {
  events.push(event);
  return events;
}

export function spinCollectionFailureCode(responsesReceived: number, requestsSeen: number): 'SPIN_OUTCOME_UNKNOWN' | 'SPIN_RESPONSE_TIMEOUT' | null {
  if (responsesReceived > 0) return null;
  return requestsSeen > 0 ? 'SPIN_OUTCOME_UNKNOWN' : 'SPIN_RESPONSE_TIMEOUT';
}

export function spinBalanceMatches(previousBalance: number, stake: number, win: number, balance: number): boolean {
  const cents = (amount: number) => Math.round(amount * 100);
  return cents(balance) === cents(previousBalance - stake + win);
}

export interface HeaderPollResult { matched: boolean; lastValue: number | null }

export function headerBalanceLagError(headerBalance: number | null, serverBalance: number): Error & { code: string; stage: string } {
  const error = new Error(`HEADER_BALANCE_LAG: header=${headerBalance}; server=${serverBalance}`) as Error & { code: string; stage: string };
  error.code = 'HEADER_BALANCE_LAG';
  error.stage = 'header-balance-poll';
  return error;
}

export async function pollHeaderBalance(
  read: () => Promise<number>, expected: number, options: { timeoutMs?: number; intervalMs?: number; now?: () => number; pause?: (ms: number) => Promise<void> } = {},
): Promise<HeaderPollResult> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 10_000);
  let lastValue: number | null = null;
  do {
    try { lastValue = await read(); } catch { lastValue = null; }
    if (lastValue === null || !Number.isFinite(lastValue)) {
      if (now() >= deadline) break;
      await pause(Math.min(options.intervalMs ?? 500, Math.max(0, deadline - now())));
      continue;
    }
    if (Math.round(lastValue * 100) === Math.round(expected * 100)) return { matched: true, lastValue };
    if (now() >= deadline) break;
    await pause(Math.min(options.intervalMs ?? 500, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return { matched: false, lastValue };
}

export function structuredSlotError(error: unknown, stage: string, secrets: string[] = []) {
  const redact = (text: string) => secrets.filter(Boolean).reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), text);
  const chain: Array<{ error: unknown; record: Record<string, unknown> }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    const record = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    chain.push({ error: current, record });
    current = record.cause;
  }
  const primary = chain.find(({ record }) => typeof record.code === 'string') ?? chain.at(-1)!;
  const message = primary.error instanceof Error ? primary.error.message : String(primary.error);
  const cause = primary.record.cause;
  const code = chain.map(({ error: item, record }) => typeof record.code === 'string' ? record.code
    : item instanceof Error && /^[A-Z0-9_]+$/.test(item.message) ? item.message : null).find(Boolean);
  const errorStage = chain.map(({ record }) => typeof record.stage === 'string' ? record.stage : null).find(Boolean) ?? stage;
  const causeText = (value: unknown, depth = 0): string => {
    if (depth >= 4 || value === undefined) return '';
    const causeRecord = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const label = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    const nested = causeText(causeRecord.cause, depth + 1);
    return redact(`${label}${nested ? `; cause: ${nested}` : ''}`);
  };
  return {
    stage: errorStage,
    code: code ?? (/^[A-Z0-9_]+$/.test(message) ? message : 'SLOT_RUN_FAILED'),
    name: primary.error instanceof Error ? primary.error.name : typeof primary.error,
    message: redact(message),
    ...(cause === undefined ? {} : { cause: causeText(cause) }),
  };
}
