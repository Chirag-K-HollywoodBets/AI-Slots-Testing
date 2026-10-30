const TEAM_ALIASES: Record<string, string> = {
  ipswich: 'ipswich',
  'ipswich town': 'ipswich',
  'manchester united': 'man utd',
  'man utd': 'man utd',
  'manchester city': 'man city',
  'man city': 'man city',
  'tottenham hotspur': 'tottenham',
  tottenham: 'tottenham',
  'nottingham': 'nottingham forest',
  'nottingham forest': 'nottingham forest',
  'nottm forest': 'nottingham forest',
};

function normalizeWords(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function canonicalTeamName(value: string): string {
  const normalized = normalizeWords(value);
  return TEAM_ALIASES[normalized] ?? normalized;
}

/** Established aliases only; unknown names retain the user's spelling. */
export function establishedTeamName(value: string): string {
  const canonical = TEAM_ALIASES[normalizeWords(value)];
  return canonical ? canonical.replace(/\b\w/g, (letter) => letter.toUpperCase()) : value;
}

export function establishedTeamAliases(): Readonly<Record<string, string>> {
  return { ...TEAM_ALIASES };
}

export function fixtureMatchesTeams(fixture: string, team: string, opponent?: string): boolean {
  const sides = fixture.split(/\s+(?:vs\.?|v)\s+/i).map(canonicalTeamName);
  if (sides.length !== 2 || !sides.includes(canonicalTeamName(team))) return false;
  if (!opponent) return true;
  return sides.includes(canonicalTeamName(opponent));
}

export function textContainsTeam(text: string, team: string): boolean {
  const normalizedText = normalizeWords(text);
  const canonical = canonicalTeamName(team);
  const variants = Object.entries(TEAM_ALIASES)
    .filter(([, value]) => value === canonical)
    .map(([name]) => name);
  return [canonical, ...variants].some((name) =>
    new RegExp(`(?:^| )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`).test(normalizedText)
  );
}

export interface RequestedSelection {
  team: string;
  opponent?: string;
}

/** App cap is 10 legs. These bonus tiers are supplied by the project owner. */
export const SOCCER_MULTIPLE_BONUS_TIERS = [
  { minLegs: 2, maxLegs: 2, bonusPercent: 2.5 },
  { minLegs: 3, maxLegs: 3, bonusPercent: 3 },
  { minLegs: 4, maxLegs: 4, bonusPercent: 4 },
  { minLegs: 5, maxLegs: 10, bonusPercent: 10 },
  { minLegs: 11, maxLegs: 15, bonusPercent: 15 },
  { minLegs: 16, maxLegs: 24, bonusPercent: 20 },
  { minLegs: 25, maxLegs: Number.POSITIVE_INFINITY, bonusPercent: 30 },
] as const;

/** General-terms requirement: number of legs whose displayed fractional odds are >= 0.2. */
export function soccerMultipleWinLimitQualifyingLegs(legs: number): number | null {
  if (!Number.isSafeInteger(legs) || legs < 2) return null;
  if (legs === 2 || legs === 3) return 2;
  if (legs <= 5) return 3;
  if (legs <= 7) return 4;
  if (legs <= 14) return 5;
  if (legs <= 24) return 7;
  return 10;
}

export function soccerMultipleBonusPercent(legs: number): number | null {
  if (!Number.isSafeInteger(legs) || legs < 2) return null;
  return SOCCER_MULTIPLE_BONUS_TIERS.find((tier) => legs >= tier.minLegs && legs <= tier.maxLegs)?.bonusPercent ?? null;
}

/** Returns whether a multiple qualifies for its leg-count win limit; null means malformed odds. */
export function qualifiesForSoccerMultipleWinLimit(displayedFractionalOdds: readonly number[]): boolean | null {
  const required = soccerMultipleWinLimitQualifyingLegs(displayedFractionalOdds.length);
  if (required === null || displayedFractionalOdds.some((odds) => !Number.isFinite(odds) || odds < 0)) return null;
  return displayedFractionalOdds.filter((odds) => odds >= 0.2).length >= required;
}

/** General Terms v2.29, Table 13.17. Values are winnings cents; soccer limits include bonus. */
export function soccerMultiplePayoutLimitCents(legs: number, displayedFractionalOdds: readonly number[]): number | null {
  if (!Number.isSafeInteger(legs) || legs < 1 || displayedFractionalOdds.length !== legs
    || displayedFractionalOdds.some((odds) => !Number.isFinite(odds) || odds < 0)) return null;
  if (legs === 1 || qualifiesForSoccerMultipleWinLimit(displayedFractionalOdds) === false) return 30_000_000;
  if (legs === 2) return 75_000_000;
  if (legs === 3) return 150_000_000;
  if (legs <= 5) return 300_000_000;
  if (legs <= 7) return 500_000_000;
  if (legs <= 14) return 1_000_000_000;
  if (legs <= 24) return 1_500_000_000;
  return 3_000_000_000;
}

/** Caps net winnings while preserving the sportsbook's Payout amount, which includes the stake. */
export function capSoccerMultipleWinnings(
  stakeCents: number,
  potentialPayoutCents: number,
  displayedFractionalOdds: readonly number[],
): { potentialPayoutCents: number; potentialProfitCents: number; payoutLimitCents: number; capped: boolean } | null {
  if (!Number.isSafeInteger(stakeCents) || stakeCents < 0
    || !Number.isSafeInteger(potentialPayoutCents) || potentialPayoutCents < stakeCents) return null;
  const payoutLimitCents = soccerMultiplePayoutLimitCents(displayedFractionalOdds.length, displayedFractionalOdds);
  if (payoutLimitCents === null) return null;
  const potentialProfitCents = potentialPayoutCents - stakeCents;
  const cappedProfitCents = Math.min(potentialProfitCents, payoutLimitCents);
  return {
    potentialPayoutCents: stakeCents + cappedProfitCents,
    potentialProfitCents: cappedProfitCents,
    payoutLimitCents,
    capped: potentialProfitCents > payoutLimitCents,
  };
}

/** Validate requested accumulator legs before any browser interaction. */
export function validateRequestedSelections(
  selections: readonly RequestedSelection[],
  availableFixtures: readonly string[],
  maximumSelections: number | null,
): { ok: true; fixtures: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(selections) || selections.length === 0) return { ok: false, reason: 'SPORTS_SELECTIONS_REQUIRED' };
  if (selections.length > 1 && (maximumSelections === null || !Number.isSafeInteger(maximumSelections) || maximumSelections < 1)) {
    return { ok: false, reason: 'SPORTS_ACCUMULATOR_LIMIT_UNVERIFIED' };
  }
  if (maximumSelections !== null && selections.length > maximumSelections) return { ok: false, reason: 'SPORTS_TOO_MANY_SELECTIONS' };

  const keys = new Set<string>();
  const resolved: string[] = [];
  for (const selection of selections) {
    const team = canonicalTeamName(selection.team);
    const opponent = selection.opponent ? canonicalTeamName(selection.opponent) : undefined;
    if (!team || (opponent && team === opponent)) return { ok: false, reason: 'SPORTS_SELECTION_INVALID' };
    const key = `${team}|${opponent ?? ''}`;
    if (keys.has(key)) return { ok: false, reason: 'SPORTS_DUPLICATE_SELECTION' };
    keys.add(key);
    const matches = availableFixtures.filter((fixture) => fixtureMatchesTeams(fixture, selection.team, selection.opponent));
    if (matches.length !== 1) return { ok: false, reason: matches.length ? 'SPORTS_FIXTURE_AMBIGUOUS' : 'SPORTS_FIXTURE_NOT_FOUND' };
    if (resolved.some((fixture) => fixture.toLocaleLowerCase() === matches[0].toLocaleLowerCase())) {
      return { ok: false, reason: 'SPORTS_CONFLICTING_SELECTIONS' };
    }
    resolved.push(matches[0]);
  }
  return { ok: true, fixtures: resolved };
}

export interface VerifiedStakeLimits {
  minCents: number;
  maxCents: number;
  incrementCents: number;
}

/** Validate exact ZAR stake cents; null limits mean the provider rules are not verified. */
export function validateSportsStakeCents(cents: number, limits: VerifiedStakeLimits | null): boolean {
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 5_000
    && limits !== null
    && Number.isSafeInteger(limits.minCents) && Number.isSafeInteger(limits.maxCents)
    && Number.isSafeInteger(limits.incrementCents) && limits.incrementCents > 0
    && cents >= limits.minCents && cents <= limits.maxCents
    && (cents - limits.minCents) % limits.incrementCents === 0;
}

export function parseStakeToCents(value: string): number | null {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Parses displayed ZAR values with either decimal points or decimal commas. */
export function parseDisplayedMoneyToCents(value: string): number | null {
  if (!/^(?:(?:ZAR|R)\s*)?\d[\d\s.,]*$/i.test(value.trim())) return null;
  const clean = value.replace(/[^\d.,]/g, '');
  if (!clean) return null;
  const comma = clean.lastIndexOf(',');
  const dot = clean.lastIndexOf('.');
  let normalized = clean;
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? clean.replace(/\./g, '').replace(',', '.')
      : clean.replace(/,/g, '');
  } else if (comma >= 0) {
    const decimals = clean.length - comma - 1;
    normalized = decimals === 1 || decimals === 2
      ? clean.replace(',', '.')
      : decimals === 3
        ? clean.replace(/,/g, '')
        : '';
  }
  return parseStakeToCents(normalized);
}

export function calculatePotential(stakeCents: number, decimalOdds: readonly number[]): {
  combinedOdds: number;
  potentialPayoutCents: number;
  potentialProfitCents: number;
} | null {
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0 || decimalOdds.length === 0) return null;
  let numerator = 1n;
  let denominator = 1n;
  for (const odds of decimalOdds) {
    const text = String(odds);
    const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
    if (!match || !Number.isFinite(odds) || odds <= 1) return null;
    const fraction = match[2] ?? '';
    const scale = 10n ** BigInt(fraction.length);
    const scaledOdds = BigInt(match[1]) * scale + BigInt(fraction || '0');
    numerator *= scaledOdds;
    denominator *= scale;
  }
  const payout = (BigInt(stakeCents) * numerator * 2n + denominator) / (2n * denominator);
  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const potentialPayoutCents = Number(payout);
  const combinedOdds = Number(numerator) / Number(denominator);
  if (!Number.isFinite(combinedOdds)) return null;
  return { combinedOdds, potentialPayoutCents, potentialProfitCents: potentialPayoutCents - stakeCents };
}

/** The sportsbook's accumulator basis is the product of (fractional leg odds + 1), minus 1. */
export function calculateAccumulatorBaseOdds(fractionalOdds: readonly number[]): number | null {
  if (fractionalOdds.length < 2 || fractionalOdds.some((odds) => !Number.isFinite(odds) || odds < 0)) return null;
  let product = 1;
  for (const odds of fractionalOdds) product *= odds + 1;
  if (!Number.isFinite(product)) return null;
  return Math.round((product - 1 + Number.EPSILON) * 100) / 100;
}

/** Apply only a bonus percentage actually observed in the sportsbook UI. */
export function applyObservedAccumulatorBonus(baseOdds: number, bonusPercent: number): number | null {
  if (!Number.isFinite(baseOdds) || baseOdds < 0 || !Number.isFinite(bonusPercent) || bonusPercent < 0) return null;
  return Math.round((baseOdds * (1 + bonusPercent / 100) + Number.EPSILON) * 100) / 100;
}

/** The reviewed displayed odds are the payout multiplier supplied for this slip. */
export function payoutCentsAtDisplayedOdds(stakeCents: number, displayedOdds: number): number | null {
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0 || !Number.isFinite(displayedOdds) || displayedOdds < 0) return null;
  const payout = Math.round(stakeCents * displayedOdds);
  return Number.isSafeInteger(payout) ? payout : null;
}
