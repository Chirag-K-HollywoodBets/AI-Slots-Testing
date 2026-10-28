import { parseDisplayedMoneyToCents, parseStakeToCents } from './sports-fixtures';

export type SlipSelection = { fixture: string; selection: string };

/** A failed click may have reached the page. Never silently replay it. */
export class SportsPreparationError extends Error {
  constructor(message: string, readonly preparation: {
    addedSelections: SlipSelection[];
    attemptedSelections: SlipSelection[];
    remainingSelections: SlipSelection[] | null;
    retryRequiresEmptySlip: true;
    failedStage?: string;
  }) {
    super(message);
    this.name = 'SportsPreparationError';
  }
}

export function verifySportsAmounts(stakeText: string, payoutText: string, requestedStakeCents: number) {
  const stakeCents = parseStakeToCents(stakeText);
  if (stakeCents !== requestedStakeCents) throw new Error('SPORTS_STAKE_MISMATCH');
  const payoutCents = parseDisplayedMoneyToCents(payoutText);
  if (payoutCents === null) throw new Error('SPORTS_PAYOUT_UNVERIFIED');
  return { stakeCents, payoutCents };
}
