export interface SlotReadout {
  bet: number;
  balance: number;
  win: number;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
