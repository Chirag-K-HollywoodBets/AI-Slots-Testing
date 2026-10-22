
import {
  PlanSchema,
  type AgentAction,
} from './schema';

export interface SpinResult {
  stake: number;
  win: number;
  balance: number;
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
  openGame(game: string): Promise<{ frameSrc: string | null }>;

  /** Plays N spins at a fixed stake. Must stop on the first stake mismatch. */
  playSlot(game: string, spins: number, stake: number): Promise<SpinResult[]>;
}

export interface ActionResult {
  action: AgentAction;
  success: boolean;
  observation?: unknown;
  error?: string;
}

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
          const spins = await browser.playSlot(
            action.game,
            action.spins,
            action.stake
          );
          const round = (n: number) => Math.round(n * 100) / 100;
          observation = {
            spins,
            totalStaked: round(spins.reduce((s, x) => s + x.stake, 0)),
            totalWon: round(spins.reduce((s, x) => s + x.win, 0)),
            finalBalance: spins.at(-1)?.balance ?? null,
          };
          break;
        }
      }

      results.push({
        action,
        success: true,
        observation,
      });
    } catch (error) {
      // Only expose our own short error codes, never raw page/network text.
      const message = error instanceof Error ? error.message : '';
      results.push({
        action,
        success: false,
        error: /^[A-Z_]+$/.test(message) ? message : 'Browser action failed',
      });

      break;
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
  };
}
