
import { SportsPreparationError } from './sports-preparation';
import {
  PlanSchema,
  type AgentAction,
} from './schema';
import { guardSlotAction } from './slot-safety';
import type { SlotObservation, SlotSpinResult } from './slot-settlement';

export type SpinResult = SlotSpinResult;
export type { SlotObservation } from './slot-settlement';

export interface SportsBetPreview {
  betType: 'single' | 'accumulator';
  selections: Array<{ fixture: string; selection: string; market: string; decimalOdds?: number; displayedOdds?: number }>;
  market: string;
  stakeCents: number;
  status: 'BETSLIP_READY';
  submitted: false;
  combinedOdds?: number;
  oddsBasis?: 'decimal' | 'sportsbook-displayed' | 'fractional-accumulator-calculation';
  baseOdds?: number;
  observedBonusPercent?: number | null;
  finalOdds?: number | null;
  displayedPayoutCents?: number;
  displayedPayoutBasis?: 'stake-inclusive' | 'sportsbook-payout' | 'unverified';
  payoutMultiplier?: number;
  payoutEffectiveDecimalOdds?: number;
  payoutAdjustmentCents?: number | null;
  bonusStatus?: 'unverified' | 'verified';
  potentialPayoutCents?: number | null;
  potentialProfitCents?: number | null;
  payoutLimitCents?: number;
  potentialWinningsCapped?: boolean;
}

export interface BrowserAdapter {
  getPageInfo(): Promise<{
    title: string;
    url: string;
  }>;

  navigateTo(path: string): Promise<void>;

  isVisible(selector: string): Promise<boolean>;

  captureEvidence(reason: string): Promise<string>;

  /** Opens an allowlisted game and waits for its iframe. */
  openGame(game: string): Promise<{ frameSrc: string | null; gameState?: Record<string, unknown> }>;

  /** Plays N spins at a fixed stake. Must stop on the first stake mismatch. */
  playSlot(game: string, spins: number, stake: number): Promise<SpinResult[]>;

  /** Sports preparation fails closed until provider limits and controls are verified. */
  prepareSportsBet(
    competition: string,
    selections: Array<{ team: string; opponent?: string }>,
    market: string,
    stakeCents: number,
    submit: boolean
  ): Promise<SportsBetPreview>;
}

type PlaySlotAction = Extract<AgentAction, { type: 'play_slot' }>;
type OtherAgentAction = Exclude<AgentAction, PlaySlotAction>;

export interface SlotFailureObservation {
  completedSpins: number;
  attemptedSpins: number;
  stoppedBeforeAnySpin: boolean;
}

export type ActionResult =
  | { action: PlaySlotAction; success: true; observation: SlotObservation }
  | { action: PlaySlotAction; success: false; observation?: SlotFailureObservation; error: string }
  | { action: OtherAgentAction; success: true; observation?: unknown }
  | { action: OtherAgentAction; success: false; observation?: unknown; error: string };
export type SuccessfulPlaySlotActionResult = Extract<ActionResult, { action: PlaySlotAction; success: true }>;

export interface ExecutionReport {
  success: boolean;
  results: ActionResult[];
}

export async function executePlan(
  input: unknown,
  browser: BrowserAdapter
): Promise<ExecutionReport> {
  const validation = PlanSchema.safeParse(input);

  if (!validation.success) {
    return {
      success: false,
      results: [],
    };
  }

  const results: ActionResult[] = [];

  for (const action of validation.data.actions) {
    try {
      let observation: unknown;
      let slotObservation: SlotObservation | undefined;

      switch (action.type) {
        case 'get_page_info':
          observation = await browser.getPageInfo();
          break;

        case 'navigate_to_allowlisted_path':
          await browser.navigateTo(action.path);
          observation = { path: action.path };
          break;

        case 'check_visible':
          observation = await browser.isVisible(
            action.selector
          );

          if (!observation) {
            throw new Error('Element is not visible');
          }
          break;

        case 'capture_evidence':
          observation = await browser.captureEvidence(
            action.reason
          );
          break;

        case 'open_game':
          observation = await browser.openGame(action.game);
          break;

        case 'play_slot': {
          guardSlotAction({ type: 'wager', wager: action.stake });
          guardSlotAction({ type: 'spin', spins: action.spins });
          const spins = await browser.playSlot(
            action.game,
            action.spins,
            action.stake
          );
          const asCents = (n: number) => Math.round(n * 100);
          slotObservation = {
            spins,
            totalStaked: spins.reduce((s, x) => s + asCents(x.stake), 0) / 100,
            totalWon: spins.reduce((s, x) => s + asCents(x.win), 0) / 100,
            finalBalance: spins.at(-1)?.balance ?? null,
          };
          observation = slotObservation;
          break;
        }

        case 'prepare_sports_bet':
          observation = await browser.prepareSportsBet(
            action.competition,
            action.selections,
            action.market,
            action.stakeCents,
            action.submit
          );
          break;
      }

      if (action.type === 'play_slot') {
        if (!slotObservation) throw new Error('SLOT_OBSERVATION_MISSING');
        results.push({ action, success: true, observation: slotObservation });
      } else {
        results.push({ action, success: true, observation });
      }
    } catch (error) {
      // Only expose our own short error codes, never raw page/network text.
      const message = error instanceof Error ? error.message : '';
      const slotFailure = error instanceof Error && 'completedSpins' in error && 'attemptedSpins' in error
        ? {
          completedSpins: Number(error.completedSpins),
          attemptedSpins: Number(error.attemptedSpins),
          stoppedBeforeAnySpin: Number(error.attemptedSpins) === 0,
        }
        : undefined;
      const safeError = /^[A-Z_]+$/.test(message) ? message : 'Browser action failed';
      if (action.type === 'play_slot') {
        results.push({ action, success: false, ...(slotFailure ? { observation: slotFailure } : {}), error: safeError });
      } else {
        results.push({
          action,
          success: false,
          ...(error instanceof SportsPreparationError ? { observation: error.preparation } : {}),
          error: safeError,
        });
      }

      break;
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
  };
}
