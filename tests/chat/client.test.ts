import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Minimal DOM boundary: no browser, network, model service or HTML parser. */
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  disabled = false;
  value = '';
  type = '';
  onclick?: () => Promise<void>;
  listeners: Record<string, (event: { preventDefault(): void }) => Promise<void>> = {};
  private text = '';
  constructor(public tagName = 'DIV') {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child; }
  append(...values: Array<Element | string>) {
    for (const value of values) {
      if (typeof value === 'string') { const node = new Element('#TEXT'); node.textContent = value; this.appendChild(node); }
      else this.appendChild(value);
    }
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(name: string, listener: Element['listeners'][string]) { this.listeners[name] = listener; }
  get lastElementChild() { return this.children.at(-1); }
}

const source = readFileSync(new URL('../../chat/client.js', import.meta.url), 'utf8');
const snapshot = { conversation: { phase: 'idle', confirmations: [] }, messages: [] };
const summary = (planId = 'plan-1', revision = 1) => ({ status: 'CONFIRM', planId, revision,
  summary: 'Team: Man City; Opponent: Brighton; Competition: Premier League; Market: Match winner; Bet type: Single; Total stake: R10.00. The agent does not submit the bet.',
  conversation: { phase: 'awaiting_confirmation', revision, confirmations: [{ planId, revision, kind: 'sports' }] } });

async function client(restored: object = snapshot) {
  type ElementId = 'form' | 'instruction' | 'mode' | 'messages' | 'send' | 'conversation-status';
  const elements = Object.fromEntries(['form', 'instruction', 'mode', 'messages', 'send', 'conversation-status'].map((id) => [id, new Element()])) as Record<ElementId, Element>;
  elements.mode.value = 'SPORTS';
  const fetch = vi.fn().mockImplementation(async (route: string) => ({ ok: route !== '/api/review-current', json: async () => route === '/api/conversation-state' ? restored : {} }));
  const context = createContext({ document: { getElementById: (id: ElementId) => elements[id], createElement: (tag: string) => new Element(tag.toUpperCase()) },
    fetch, crypto: { randomUUID: () => 'message-1' }, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(), Date, console });
  runInContext(source, context);
  await vi.waitFor(() => expect(elements.send.disabled).toBe(false));
  return { ...elements, fetch, context,
    add: (role: string, text: string) => context.addMessage(role, text) as Element,
    render: (element: Element, result: object, ok = true) => context.render(element, { ok }, result),
  };
}

describe('chat client conversation flow with mocked DOM and HTTP', () => {
  it('shows submission progress, prevents a duplicate click, and displays the server rejection', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, { status: 'REVIEW_READY', reviewId: 'review-1', revision: 1,
      expiresAt: Date.now() + 60_000, idempotencyKey: 'mock-key', submissionEnabled: true,
      actions: [{ type: 'prepare_sports_bet', betslip: { betType: 'single', market: 'match-winner',
        selections: [{ fixture: 'Man City vs Brighton', selection: 'Man City', displayedOdds: 0.6 }],
        stakeCents: 1000, oddsBasis: 'sportsbook-displayed', displayedPayoutBasis: 'sportsbook-payout',
        displayedPayoutCents: 600 } }] });
    const submit = bubble.children.find((child) => child.textContent === 'Submit R10.00 bet')!;
    expect(submit.disabled).toBe(false);
    let finish!: (value: unknown) => void;
    app.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const inFlight = submit.onclick!();
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Checking slip');
    await submit.onclick!();
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/submit-review')).toHaveLength(1);
    finish({ ok: false, json: async () => ({ error: 'Review is stale, closed, or expired.' }) });
    await inFlight;
    expect(bubble.textContent).toContain('Review is stale, closed, or expired.');
    expect(bubble.textContent).not.toContain('outcome is unknown');
  });

  it('passes the JavaScript syntax check', () => {
    expect(() => new Script(source)).not.toThrow();
  });

  it('keeps earlier messages and displays user/model strings as literal text', async () => {
    const app = await client();
    const text = '<img src=x onerror="alert(1)">';
    const user = app.add('user', text);
    const question = app.add('agent', '');
    app.render(question, { status: 'CLARIFICATION', reason: 'Who is Man City playing? ' + text, conversation: { phase: 'clarification', confirmations: [] } });
    expect(user.textContent).toBe(text);
    expect(question.textContent).toContain(text);
    expect(user.children).toHaveLength(0);
    expect(question.children).toHaveLength(0);
    expect(app.messages.children).toEqual([user, question]);
    expect(app['conversation-status'].dataset.state).toBe('clarification');
    expect(app.fetch.mock.calls.every(([route]) => !String(route).includes('/api/confirm'))).toBe(true);
  });

  it('shows a confirmation summary without executing and removes old controls after a correction', async () => {
    const app = await client();
    const first = app.add('agent', '');
    app.render(first, summary());
    expect(first.children.filter((child) => child.tagName === 'BUTTON').map((child) => child.textContent)).toEqual(['Confirm and run', 'Cancel']);
    const next = app.add('agent', '');
    app.render(next, summary('plan-2', 2));
    expect(first.textContent).toContain('Team: Man City');
    expect(first.textContent).toContain('no longer active');
    expect(first.children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(0);
    expect(next.children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(2);
    expect(app['conversation-status'].dataset.state).toBe('awaiting_confirmation');
    expect(app.fetch).toHaveBeenCalledTimes(2); // Session and current-review reads only.
  });

  it('sends a confirmation at most once, then shows running and manual review states', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, summary());
    const confirm = bubble.children.find((child) => child.textContent === 'Confirm and run')!;
    app.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'REVIEW_STARTING', reviewId: 'review-1', usage: { source: 'reported', totalTokens: 42 } }) });
    const first = confirm.onclick!();
    await confirm.onclick!();
    await first;
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/confirm')).toHaveLength(1);
    expect(app['conversation-status'].dataset.state).toBe('running');
    expect(app.send.disabled).toBe(true);
    app.render(app.messages.lastElementChild!, { status: 'REVIEW_READY', reviewId: 'review-1', revision: 2,
      idempotencyKey: 'mock-key', submissionEnabled: true, competition: 'premier-league', expiresAt: Date.now() + 10_000,
      usage: { source: 'reported', totalTokens: 42 }, actions: [{ type: 'prepare_sports_bet', betslip: {
        selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal', displayedOdds: 0.65 }], betType: 'single',
        market: 'match-winner', stakeCents: 1000, combinedOdds: 0.65, oddsBasis: 'sportsbook-displayed',
        payoutMultiplier: 0.65, payoutAdjustmentCents: 0, displayedPayoutCents: 650,
        potentialPayoutCents: 650, potentialProfitCents: null,
      } }] });
    expect(app['conversation-status'].dataset.state).toBe('manual_review');
    expect(app.messages.lastElementChild?.textContent).toContain('When enabled, clicking Submit places this bet');
    expect(app.messages.lastElementChild?.children.filter((child) => child.tagName === 'BUTTON').map((child) => child.textContent))
      .toEqual(['Submit R10.00 bet', 'Finish without submitting']);
    expect(app.messages.lastElementChild?.textContent).toContain('total 42');
    expect(app.fetch.mock.calls.every(([route]) => !String(route).includes('submit'))).toBe(true);
  });

  it('restores only the current session transcript and only its active confirmation controls', async () => {
    const current = summary('latest', 2);
    const app = await client({ conversation: current.conversation, messages: [
      { role: 'user', text: 'Prepare Man City to win' },
      { role: 'agent', result: { status: 'CLARIFICATION', reason: 'Who is Man City playing?' } },
      { role: 'agent', result: summary('old', 1) }, { role: 'agent', result: current },
    ] });
    expect(app.messages.children).toHaveLength(4);
    expect(app.messages.children[2].textContent).toContain('no longer active');
    expect(app.messages.children[2].children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(0);
    expect(app.messages.children[3].children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(2);
    expect(app['conversation-status'].dataset.state).toBe('awaiting_confirmation');
  });

  it('does not leave the chat stuck in running state after a stale confirmation rejection', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, summary());
    app.fetch.mockResolvedValue({ ok: false, json: async () => ({ code: 'PLAN_EXPIRED', error: 'Plan expired or unknown.' }) });
    await bubble.children.find((child) => child.textContent === 'Confirm and run')!.onclick!();
    expect(app.messages.lastElementChild?.textContent).toContain('PLAN_EXPIRED');
    expect(app.send.disabled).toBe(false);
    expect(app['conversation-status'].dataset.state).toBe('idle');
  });

  it('sends a clarification reply once without confirming and retains usage reporting', async () => {
    const app = await client();
    app.instruction.value = 'R10';
    app.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...summary(), usage: {
      source: 'reported', model: '<script>alert(1)</script>', inputTokens: 30, outputTokens: 12, totalTokens: 42,
    } }) });
    const first = app.form.listeners.submit({ preventDefault() {} });
    await app.form.listeners.submit({ preventDefault() {} });
    await first;
    expect(app.messages.children[0].textContent).toBe('R10');
    expect(app.messages.lastElementChild?.textContent).toContain('input 30, output 12, total 42');
    expect(app.messages.lastElementChild?.textContent).toContain('<script>alert(1)</script>');
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/run')).toHaveLength(1);
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/confirm')).toHaveLength(0);
    expect(app['conversation-status'].dataset.state).toBe('awaiting_confirmation');
  });

  it('cancels through the server and keeps the original summary visible', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, summary());
    app.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'CANCELLED', reason: 'Cancelled. Nothing was run.',
      conversation: { phase: 'idle', confirmations: [] } }) });
    await bubble.children.find((child) => child.textContent === 'Cancel')!.onclick!();
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/cancel')).toHaveLength(1);
    expect(bubble.textContent).toContain('Team: Man City');
    expect(bubble.children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(0);
    expect(app.messages.lastElementChild?.textContent).toContain('Cancelled. Nothing was run.');
    expect(app.send.disabled).toBe(false);
  });

  it('does not recreate expired confirmation controls on reload', async () => {
    const expired = { ...summary(), expiresAt: Date.now() - 1 };
    const app = await client({ conversation: { phase: 'clarification', confirmations: [] }, messages: [
      { role: 'agent', result: expired },
    ] });
    expect(app.messages.children[0].children.filter((child) => child.tagName === 'BUTTON')).toHaveLength(0);
    expect(app['conversation-status'].dataset.state).toBe('clarification');
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/confirm')).toHaveLength(0);
  });

  it('preserves the single-slip 0.65 × R10 = R6.50 payout without adding stake or labelling it profit', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, { status: 'REVIEW_READY', reviewId: 'single-review', expiresAt: Date.now() + 10000, actions: [
      { type: 'prepare_sports_bet', betslip: { betType: 'single', market: 'match-winner',
        selections: [{ fixture: 'Man City vs Brighton', selection: 'Man City', displayedOdds: 0.65 }],
        combinedOdds: 0.65, oddsBasis: 'sportsbook-displayed', payoutMultiplier: 0.65,
        payoutAdjustmentCents: 0, displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout',
        stakeCents: 1000, potentialPayoutCents: 650, potentialProfitCents: null } },
    ] });
    expect(bubble.textContent).toContain('Base odds (sportsbook displayed): 0.65');
    expect(bubble.textContent).toContain('Total stake: R10.00');
    expect(bubble.textContent).toContain('Sportsbook displayed Payout: R6.50');
    expect(bubble.textContent).toContain('Potential payout (after configured cap): R6.50');
    expect(bubble.textContent).not.toContain('R16.50');
    expect(bubble.textContent).not.toContain('profit:');
    expect(app.fetch.mock.calls.filter(([route]) => route === '/api/confirm')).toHaveLength(0);
  });

  it('shows the corrected accumulator base and supplied example payout without assuming its bonus', async () => {
    const app = await client();
    const bubble = app.add('agent', '');
    app.render(bubble, { status: 'REVIEW_READY', reviewId: 'acc-review', revision: 1,
      expiresAt: Date.now() + 10_000, idempotencyKey: 'mock-key', submissionEnabled: true,
      competition: 'premier-league', actions: [{ type: 'prepare_sports_bet', betslip: {
        status: 'BETSLIP_READY', submitted: false, betType: 'accumulator', market: 'match-winner', stakeCents: 1000,
        selections: [
          { fixture: 'A vs B', selection: 'A', displayedOdds: 3.00 },
          { fixture: 'C vs D', selection: 'C', displayedOdds: 1.95 },
        ], baseOdds: 10.8, combinedOdds: 10.8, oddsBasis: 'fractional-accumulator-calculation',
        observedBonusPercent: null, finalOdds: null, bonusStatus: 'unverified', displayedPayoutCents: 11070,
        displayedPayoutBasis: 'unverified', payoutMultiplier: 11.07, payoutAdjustmentCents: null,
        potentialPayoutCents: null, potentialProfitCents: null,
      } }] });
    expect(bubble.textContent).toContain('Base odds (calculated from displayed leg odds; not sportsbook-verified): 10.80');
    expect(bubble.textContent).toContain('Bonus: unverified; no bonus assumed');
    expect(bubble.textContent).toContain('Final odds: unverified');
    expect(bubble.textContent).toContain('Sportsbook displayed Payout: R110.70');
    expect(bubble.textContent).toContain('Payout basis: unverified');
    expect(bubble.textContent).not.toContain('profit');
    const submit = bubble.children.find((child) => child.textContent === 'Submit R10.00 bet');
    expect(submit?.disabled).toBe(true);
  });
});
