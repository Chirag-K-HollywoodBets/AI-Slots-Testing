export interface SlotReadout {
  bet: number;
  balance: number;
  win: number;
}

export interface SlotSpinResult {
  spin: number;
  stake: number;
  win: number;
  balance: number;
  serverFields: Array<{ c: number | null; l: number | null; tw: number | null; balance: number | null }>;
  doSpinRequestsSent?: number;
  doSpinResponsesReceived?: number;
  frameRect?: { x: number; y: number; w: number; h: number };
  spinClick?: { iframe: { x: number; y: number }; page: { x: number; y: number } };
  requestGuardCounts?: Array<Record<string, number>>;
}

/** Stable executor observation returned by a successful play_slot action. */
export interface SlotObservation {
  spins: SlotSpinResult[];
  totalStaked: number;
  totalWon: number;
  finalBalance: number | null;
  doSpinRequestsSent: number;
  doSpinResponsesReceived: number;
  spinsSettled: number;
  frameRect?: { x: number; y: number; w: number; h: number };
  spinClick?: { iframe: { x: number; y: number }; page: { x: number; y: number } };
  requestGuardCounts?: Array<Record<string, number>>;
}

export interface SlotObservationSettlement {
  spinResults: SlotSpinResult[];
  totalStaked: number;
  totalWon: number;
  expectedBalance: number;
}

/** Parse rand text with either a comma or dot decimal and common thousands separators. */
export function parseRand(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') throw new Error('INVALID_RAND_AMOUNT');

  const normalized = value.trim().replace(/^R\s*/i, '').replace(/[\s\u00a0\u202f]/g, '');
  const decimal = normalized.match(/([,.])(\d{2})$/);
  const whole = decimal ? normalized.slice(0, -3) : normalized;
  const ungrouped = /^\d+$/.test(whole);
  const grouped = /^(\d{1,3})([,.])(\d{3})(?:\2\d{3})*$/.test(whole);
  if (!ungrouped && !grouped) throw new Error('INVALID_RAND_AMOUNT');

  const digits = whole.replace(/[,.]/g, '');
  const parsed = Number(decimal ? `${digits}.${decimal[2]}` : digits);
  if (!Number.isFinite(parsed)) throw new Error('INVALID_RAND_AMOUNT');
  return parsed;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Expected final balance after exactly the confirmed paid spins and reported wins. */
export function expectedSlotBalanceAfterSpins(
  balanceBefore: number,
  spins: number,
  stake: number,
  totalWon: number,
): number {
  if (![balanceBefore, stake, totalWon].every(Number.isFinite)
    || !Number.isInteger(spins) || spins < 1 || balanceBefore < 0 || stake <= 0 || totalWon < 0) {
    throw new Error('INVALID_SLOT_SETTLEMENT');
  }
  return roundMoney(balanceBefore - spins * stake + totalWon);
}

/** Extract the executor's typed observation and reconcile its reported spins. */
export function settleSlotObservation(
  balanceBefore: number,
  observation: SlotObservation | undefined,
  expectedSpins: number,
): SlotObservationSettlement {
  if (!observation || !Array.isArray(observation.spins)
    || !Number.isInteger(expectedSpins) || expectedSpins < 1
    || observation.spins.length !== expectedSpins || observation.spins.length === 0) {
    throw new Error('SPIN_SETTLEMENT_DATA_INCOMPLETE');
  }
  if (!Number.isFinite(balanceBefore) || balanceBefore < 0
    || observation.spins.some((spin) => !Number.isFinite(spin.stake) || spin.stake <= 0
      || !Number.isFinite(spin.win) || spin.win < 0
      || !Number.isFinite(spin.balance) || spin.balance < 0)) {
    throw new Error('INVALID_SLOT_SETTLEMENT');
  }

  const cents = (value: number) => Math.round(value * 100);
  const totalStaked = observation.spins.reduce((sum, spin) => sum + cents(spin.stake), 0) / 100;
  const totalWon = observation.spins.reduce((sum, spin) => sum + cents(spin.win), 0) / 100;
  const expectedBalance = Math.round((cents(balanceBefore) - cents(totalStaked) + cents(totalWon))) / 100;
  return { spinResults: observation.spins, totalStaked, totalWon, expectedBalance };
}

function normalizeMoney(value: unknown, field: string, missingAsZero = false): number {
  if ((value === null || value === undefined || value === '') && missingAsZero) return 0;

  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/[R,r\s,]/g, ''))
      : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`INVALID_${field.toUpperCase()}_VALUE`);
  return roundMoney(parsed);
}

/** Normalize model output before using money values in comparisons. */
export function normalizeSlotReadout(value: unknown): SlotReadout {
  if (!value || typeof value !== 'object') throw new Error('INVALID_SLOT_READOUT');
  const record = value as Record<string, unknown>;
  const readout = {
    bet: normalizeMoney(record.bet, 'bet'),
    balance: normalizeMoney(record.balance, 'balance'),
    win: normalizeMoney(record.win, 'win', true),
  };
  if (readout.bet <= 0 || readout.balance < 0 || readout.win < 0) {
    throw new Error('INVALID_SLOT_READOUT');
  }
  return readout;
}

export interface SettlementAssessment {
  expectedBalance: number;
  difference: number;
  stable: boolean;
  reconciled: boolean;
  ready: boolean;
}

export type SettlementPollDecision = 'settled' | 'continue' | 'timeout';

/** A completed ready read wins over the deadline; only a non-ready read can time out. */
export function decideSettlementPoll(
  assessment: SettlementAssessment,
  completedAtMs: number,
  deadlineAtMs: number,
): SettlementPollDecision {
  if (assessment.ready) return 'settled';
  return completedAtMs >= deadlineAtMs ? 'timeout' : 'continue';
}

/** Require a reconciled balance and an unchanged balance/win pair. */
export function assessSettlementRead(
  current: SlotReadout,
  previous: SlotReadout | undefined,
  balanceBefore: number,
  bet: number,
): SettlementAssessment {
  const expectedBalance = roundMoney(balanceBefore - bet + current.win);
  const difference = Math.abs(current.balance - expectedBalance);
  const stable = previous !== undefined
    && previous.balance === current.balance
    && previous.win === current.win;
  const reconciled = Math.abs(
    Math.round(current.balance * 100) - Math.round(expectedBalance * 100),
  ) <= 1;
  return { expectedBalance, difference, stable, reconciled, ready: stable && reconciled };
}
