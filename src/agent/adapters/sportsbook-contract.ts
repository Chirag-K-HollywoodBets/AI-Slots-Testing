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
  emptySlipText: 'Place a bet',
  multiple: 'Multiple',
  accumulator: 'Multiple Accumulator',
  stakeLabel: 'Stake',
  payoutLabel: 'Payout',
  waits: { page: 30_000, navigation: 15_000, control: 10_000, poll: 250 },
} as const;
