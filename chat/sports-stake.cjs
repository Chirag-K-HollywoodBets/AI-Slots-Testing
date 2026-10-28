const SPORTS_LIMITS = Object.freeze({ minCents: 100, maxCents: 5000, incrementCents: 1 });

function extractExplicitStakeCents(instruction) {
  const amountPattern = /\bR\s*(\d+(?:\.\d{1,2})?)(?![\d.,])\b|\b(\d+(?:\.\d{1,2})?)(?![\d.,])\s*ZAR\b/gi;
  const matches = [...instruction.matchAll(amountPattern)];
  if (matches.length !== 1) return { ok: false, reason: 'SPORTS_STAKE_EXPLICIT_SINGLE_AMOUNT_REQUIRED' };
  const amount = matches[0][1] ?? matches[0][2];
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, reason: 'SPORTS_STAKE_INVALID' };
  if (cents < SPORTS_LIMITS.minCents) return { ok: false, reason: 'SPORTS_STAKE_BELOW_MINIMUM' };
  if (cents > SPORTS_LIMITS.maxCents) return { ok: false, reason: 'SPORTS_STAKE_OVER_R50' };
  if ((cents - SPORTS_LIMITS.minCents) % SPORTS_LIMITS.incrementCents !== 0) {
    return { ok: false, reason: 'SPORTS_STAKE_INCREMENT_INVALID' };
  }
  return { ok: true, stakeCents: cents };
}

module.exports = { extractExplicitStakeCents, SPORTS_LIMITS };
