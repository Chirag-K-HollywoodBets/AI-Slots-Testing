export const MAX_WAGER = 0.2;
export const MAX_SPINS = 100;

export type SlotAction =
  | { type: 'wager'; wager: number }
  | { type: 'spin'; spins: number };

/** Throw before a slot action if its value is invalid or exceeds the fixed caps. */
export function guardSlotAction(action: SlotAction): void {
  if (action.type === 'wager') {
    if (!Number.isFinite(action.wager) || action.wager <= 0 || action.wager > MAX_WAGER) {
      throw new Error('WAGER_LIMIT_EXCEEDED');
    }
    return;
  }

  if (!Number.isInteger(action.spins) || action.spins <= 0 || action.spins > MAX_SPINS) {
    throw new Error('SPIN_LIMIT_EXCEEDED');
  }
}
