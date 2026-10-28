const GAME_NAMES = Object.freeze({ 'games-in-olympus': 'Games in Olympus' });

function describeSlotPlan(spin) {
  const name = GAME_NAMES[spin.game];
  if (!name) throw new Error('GAME_NOT_ALLOWED');
  const stakeCents = Math.round(spin.stake * 100);
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0) throw new Error('STAKE_NOT_ALLOWED');
  const totalCents = spin.spins * stakeCents;
  return 'Sign in with the test account, open ' + name + ', and play ' +
    spin.spins + ' spin(s) at R' + (stakeCents / 100).toFixed(2) +
    ' (up to R' + (totalCents / 100).toFixed(2) + ' staked).\nOnly confirm if this account uses test credits.';
}

module.exports = { describeSlotPlan };
