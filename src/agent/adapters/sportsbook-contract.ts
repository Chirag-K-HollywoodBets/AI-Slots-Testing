// Update this contract when the sportsbook markup changes. Missing or ambiguous
// controls must fail verification; do not add broad fallback click targets.
export const SPORTSBOOK = {
  route: '/betting/1/soccer/all',
  leagueCard: /^league-card-link-/,
  leagueName: /\bPremier League\b/i,
  country: 'England',
  eventName: 'span.event-name',
  optionsForEvent: (index: number) =>
    `(//span[contains(@class,"event-name")])[${index + 1}]/ancestor::section[contains(@class,"component-market-item")][1]//section[@data-testid="component-market-item"]`,
  slipItem: '[data-testid="bet-item-container"]',
  slipName: '[data-testid="bet-name"]',
  slipInfo: '[data-testid="bet-info"]',
  slipOdds: '[data-testid="bet-odds"]',
  stakeInput: '[data-testid="input-stake"]',
  payoutInput: '[data-testid="input-payout"]',
  emptySlipText: 'Place a bet',
  multiple: 'Multiple',
  accumulator: 'Multiple Accumulator',
  stakeLabel: 'Stake',
  payoutLabel: 'Payout',
  bonusLabel: 'Bonus',
  finalOddsLabel: 'Final odds',
  marketText: 'match winner',
  submitButton: '[data-testid="betslip-container"] button[data-testid="submit-btn"]',
  betslipContainer: '[data-testid="betslip-container"]',
  // The result budget starts after the single click and is independent of the
  // review authorization expiry, which is checked immediately before dispatch.
  waits: { page: 30_000, navigation: 15_000, control: 10_000, poll: 250, submissionResult: 30_000 },
} as const;
