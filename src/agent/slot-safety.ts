export const MAX_WAGER = 0.2;
export const MAX_SPINS = 100;

export interface NormalizedSlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const SLOT_DISMISS_TARGET_MARGIN = { x: 0.015, y: 0.02 } as const;

// Measured on midscene_run/scout-failure.png (1024x576 screenshot; game frame
// spans approximately y=86..576). Feature controls and the Prize Drops collapse
// arrow occupy x≈0..0.25, y≈0.12..0.57 of that frame; bounds include margin.
// The two bottom clusters are also measured from that screenshot and expanded
// around the visible spin/autoplay/plus and info/sound/credit/bet controls.
export const SLOT_NO_CLICK_ZONES = [
  { name: 'left-feature-controls', left: 0, top: 0.08, right: 0.30, bottom: 0.62 },
  { name: 'bottom-spin-autoplay-plus-controls', left: 0.63, top: 0.76, right: 0.87, bottom: 1 },
  { name: 'bottom-left-info-sound-credit-bet-controls', left: 0.11, top: 0.84, right: 0.38, bottom: 1 },
] as const;

export const SLOT_BOTTOM_CENTRE_GUARD = {
  name: 'bottom-centre-modal-dismiss',
  left: 0.36,
  top: 0.72,
  right: 0.64,
  bottom: 1,
} as const;

export interface SlotDismissContext {
  overlay?: 'none' | 'win_celebration' | 'prize_drops' | 'free_spins' | 'other';
  blocksSpin?: boolean;
  targetLabel?: string;
}

function intersectsZone(
  target: { left: number; top: number; right: number; bottom: number },
  zone: { left: number; top: number; right: number; bottom: number },
): boolean {
  return !(target.right <= zone.left || target.left >= zone.right
    || target.bottom <= zone.top || target.top >= zone.bottom);
}

/** True only when the target plus its margin misses controls and passes the modal exception. */
export function isSlotDismissTargetSafe(target: NormalizedSlotRect, context: SlotDismissContext = {}): boolean {
  const values = [target.left, target.top, target.width, target.height];
  if (!values.every(Number.isFinite) || target.width <= 0 || target.height <= 0) return false;

  const left = target.left - SLOT_DISMISS_TARGET_MARGIN.x;
  const top = target.top - SLOT_DISMISS_TARGET_MARGIN.y;
  const right = target.left + target.width + SLOT_DISMISS_TARGET_MARGIN.x;
  const bottom = target.top + target.height + SLOT_DISMISS_TARGET_MARGIN.y;
  if (left < 0 || top < 0 || right > 1 || bottom > 1) return false;

  const expanded = { left, top, right, bottom };
  if (SLOT_NO_CLICK_ZONES.some((zone) => intersectsZone(expanded, zone))) return false;

  if (intersectsZone(expanded, SLOT_BOTTOM_CENTRE_GUARD)) {
    const label = context.targetLabel?.trim().toLowerCase();
    if (context.overlay !== 'prize_drops' || context.blocksSpin !== true || (label !== 'ok' && label !== 'close')) {
      return false;
    }
  }
  return true;
}

export class SlotSpinResponseCounter {
  private responses = 0;

  constructor(readonly expected: number) {
    if (!Number.isInteger(expected) || expected < 1) throw new Error('SPIN_COUNT_INVALID');
  }

  get count(): number {
    return this.responses;
  }

  recordDoSpinResponse(): number {
    this.responses++;
    if (this.responses > this.expected) throw new Error('EXTRA_SPIN_RESPONSE');
    return this.responses;
  }

  assertComplete(): void {
    if (this.responses !== this.expected) throw new Error('SPIN_RESPONSE_COUNT_MISMATCH');
  }
}

export type SlotAction =
  | { type: 'wager'; wager: number }
  | { type: 'spin'; spins: number };

/** Throw before a slot action if its value is invalid or exceeds the fixed caps. */
export function guardSlotAction(action: SlotAction, limits: { maxSpins?: number } = {}): void {
  if (action.type === 'wager') {
    if (!Number.isFinite(action.wager) || action.wager <= 0 || action.wager > MAX_WAGER) {
      throw new Error('WAGER_LIMIT_EXCEEDED');
    }
    return;
  }

  const maxSpins = limits.maxSpins === undefined ? MAX_SPINS : Math.min(MAX_SPINS, limits.maxSpins);
  if (!Number.isInteger(maxSpins) || maxSpins < 1
    || !Number.isInteger(action.spins) || action.spins <= 0 || action.spins > maxSpins) {
    throw new Error('SPIN_LIMIT_EXCEEDED');
  }
}
