import { createHash } from 'node:crypto';
import { SPORTSBOOK } from './adapters/sportsbook-contract';
import { parseDisplayedMoneyToCents, parseStakeToCents } from './sports-fixtures';

export async function submitReviewedSportsBet(browser: any, command: any, reviewedBetslip: Record<string, any>) {
  const expectedDetails = command.reviewedDetails;
  if (!expectedDetails || createHash('sha256').update(JSON.stringify(expectedDetails)).digest('hex') !== command.fingerprint
    || JSON.stringify(expectedDetails.betslip) !== JSON.stringify(reviewedBetslip)) {
    return { outcome: 'blocked', reason: 'The reviewed slip authorization could not be verified.' };
  }
  const live = await browser.evaluate((selectors: any) => {
    const containers = document.querySelectorAll<HTMLElement>(selectors.container);
    const container = containers.length === 1 ? containers[0] : null;
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(selectors.item)).map((item) => ({
      selection: item.querySelector<HTMLElement>(selectors.name)?.innerText.trim() ?? '',
      fixture: item.querySelector<HTMLElement>(selectors.info)?.innerText.trim() ?? '',
      odds: item.querySelector<HTMLElement>(selectors.odds)?.innerText.trim() ?? '',
      text: item.innerText,
    }));
    const labelValue = (name: string) => {
      const labels = Array.from(container.querySelectorAll('label')).filter((label) => label.innerText.trim() === name);
      if (labels.length !== 1) return null;
      const field = labels[0].htmlFor ? document.getElementById(labels[0].htmlFor) : labels[0].querySelector('input');
      return field instanceof HTMLInputElement ? field.value : null;
    };
    const text = container.innerText;
    const inputValue = (selector: string) => {
      const fields = container.querySelectorAll<HTMLInputElement>(selector);
      return fields.length === 1 && fields[0].getClientRects().length ? fields[0].value : null;
    };
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>(selectors.submit));
    return { rows, stake: inputValue(selectors.stakeInput), payout: inputValue(selectors.payoutInput), text,
      betType: text.includes(selectors.accumulatorLabel) ? 'accumulator' : rows.length === 1 ? 'single' : 'unverified',
      submitCount: submit.length, submitVisible: submit.length === 1 && !!submit[0].getClientRects().length,
      submitEnabled: submit.length === 1 && !submit[0].disabled,
      bonus: labelValue(selectors.bonus), finalOdds: labelValue(selectors.finalOdds) };
  }, { container: SPORTSBOOK.betslipContainer, item: SPORTSBOOK.slipItem, name: SPORTSBOOK.slipName,
    info: SPORTSBOOK.slipInfo, odds: SPORTSBOOK.slipOdds, stakeInput: SPORTSBOOK.stakeInput,
    payoutInput: SPORTSBOOK.payoutInput, submit: SPORTSBOOK.submitButton, stake: SPORTSBOOK.stakeLabel,
    payout: SPORTSBOOK.payoutLabel, bonus: SPORTSBOOK.bonusLabel, finalOdds: SPORTSBOOK.finalOddsLabel,
    marketText: SPORTSBOOK.marketText, accumulatorLabel: SPORTSBOOK.accumulator, multipleLabel: SPORTSBOOK.multiple });
  if (!live || !Array.isArray(live.rows) || !live.rows.length || live.rows.some((row: any) => !row.selection || !row.fixture)
    || live.stake === null || live.payout === null) {
    return { outcome: 'blocked', reason: 'The live slip details could not be verified. No click was made.' };
  }
  const expected = expectedDetails.betslip;
  const rowsMatch = expected.selections.length === live.rows.length && expected.selections.every((item: any, index: number) => {
    const row = live.rows[index];
    const fullTime = row.selection.match(/^full time\s*[-–]\s*(.+)$/i);
    return expected.market === 'match-winner' && fullTime
      && fullTime[1].trim().toLocaleLowerCase() === item.selection.toLocaleLowerCase()
      && row.fixture.split(/\r?\n/)[0].trim().toLocaleLowerCase() === item.fixture.toLocaleLowerCase();
  });
  const stakeCents = parseStakeToCents(live.stake);
  const payoutCents = parseDisplayedMoneyToCents(live.payout);
  const oddsMatch = expected.selections.every((item: any, index: number) => {
    const odds = live.rows[index].odds;
    return /^\d+(?:\.\d+)?$/.test(odds) && Number.isFinite(item.displayedOdds)
      && Number(odds) === item.displayedOdds;
  });
  const bonus = live.bonus === null ? null : Number(String(live.bonus).replace(/[^\d.]/g, ''));
  const finalOdds = live.finalOdds === null ? null : Number(String(live.finalOdds).replace(/[^\d.]/g, ''));
  if (!rowsMatch || !oddsMatch || stakeCents !== expected.stakeCents || payoutCents !== expected.displayedPayoutCents
    || (expected.betType === 'single' ? live.betType !== 'single' : live.betType !== 'accumulator')
    || (expected.betType === 'accumulator' && (bonus === null || finalOdds === null
      || bonus !== expected.observedBonusPercent || finalOdds !== expected.finalOdds))) {
    return { outcome: 'changed', reason: 'The live slip differs from the reviewed snapshot. No Submit click was made; finish this review and prepare a new one.' };
  }
  const button = browser.locator(SPORTSBOOK.submitButton);
  if (live.submitCount !== 1 || !live.submitVisible || !live.submitEnabled
    || await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) {
    return { outcome: 'blocked', reason: 'The sportsbook Submit control is unavailable or disabled. No click was made.' };
  }
  // The guard stays installed throughout preparation/review. Remove it only
  // after all live fields and the unique enabled button have been verified.
  await browser.evaluate(() => {
    const guarded = window as Window & { __hbSportsSubmitGuard?: { remove: () => void } };
    guarded.__hbSportsSubmitGuard?.remove();
  });
  // Capture post-click DOM changes before dispatch so short-lived screens are
  // not missed. No acceptance/rejection selectors or phrases are inferred from
  // this generic text history; receipt evidence remains unsupported until
  // actual provider markup is inspected.
  const observerKey = '__hbSportsSubmissionObservation';
  await browser.evaluate((key: string) => {
    const target = document.body;
    if (!target || typeof MutationObserver === 'undefined') return;
    const state = { startedAt: Date.now(), snapshots: [] as string[], observer: null as MutationObserver | null };
    state.observer = new MutationObserver(() => {
      state.snapshots.push(target.innerText || '');
      if (state.snapshots.length > 100) state.snapshots.shift();
    });
    state.observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
    (window as any)[key] = state;
  }, observerKey);
  const unknown = 'Submission attempted—acceptance unverified. Check My Bets before trying again.';
  try {
    if (Number.isFinite(command.expiresAt) && command.expiresAt <= Date.now()) {
      return { outcome: 'blocked', reason: 'Submission authorization expired before dispatch.' };
    }
    try {
      await button.click({ timeout: SPORTSBOOK.waits.control });
    } catch {
      return { outcome: 'unknown', reason: unknown };
    }
    const deadline = Date.now() + SPORTSBOOK.waits.submissionResult;
    while (Date.now() < deadline) {
      const snapshots = await browser.evaluate((key: string) => {
        const state = (window as any)[key];
        return state ? state.snapshots.slice() : [];
      }, observerKey);
      if (Array.isArray(snapshots) && snapshots.some((text: unknown) => typeof text === 'string'
        && /odds have changed|accept new odds|confirm changed odds|additional confirmation/i.test(text))) {
        return { outcome: 'unknown', reason: 'The sportsbook requested an additional confirmation. Review the changed terms manually; no further action was taken.' };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(SPORTSBOOK.waits.poll, Math.max(1, deadline - Date.now()))));
    }
    return { outcome: 'unknown', reason: unknown };
  } finally {
    await browser.evaluate((key: string) => {
      const state = (window as any)[key];
      state?.observer?.disconnect();
      delete (window as any)[key];
    }, observerKey).catch(() => undefined);
  }
}
