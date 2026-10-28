import {
  PlannerResponseSchema,
  ALLOWED_PATHS,
  GAME_IDS,
  ALLOWED_STAKES,
  MAX_SPINS,
  type PlannerResponse,
} from './schema';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

export interface PlannerOptions {
  apiKey?: string;
  baseUrl: string;
  modelName: string;
  // Allow passing a custom model for testing purposes
  customModel?: any;
}

/** Small, sanitized summary of provider-reported token usage. */
export interface PlannerUsage {
  source: 'reported';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type PlannerResult = PlannerResponse & { usage?: PlannerUsage };

function readUsage(value: unknown, modelName: string): PlannerUsage | undefined {
  try {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const counts: Partial<Pick<PlannerUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>> = {};
  for (const [key, sourceKey] of [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['totalTokens', 'totalTokens'],
  ] as const) {
    const count = raw[sourceKey];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count;
  }
  if (Object.keys(counts).length === 0) return undefined;
  return { source: 'reported', model: modelName, ...counts };
  } catch {
    // Usage is advisory metadata; malformed provider objects must not affect planning.
    return undefined;
  }
}

export class Planner {
  private model: any;
  private modelName: string;

 
constructor(options: PlannerOptions) {
  this.modelName = options.modelName;

  if (options.customModel) {
    this.model = options.customModel;
  } else {
    const provider = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: options.baseUrl,
      apiKey: options.apiKey || 'dummy-key',
    });

    this.model = provider.chatModel(options.modelName);
  }
}
  /**
   * Generates a structured action plan from a natural language instruction.
   */
  async plan(instruction: string): Promise<PlannerResult> {
    
const systemPrompt = `
If the request is allowed:
Return a valid plan containing "thought" and a non-empty
"actions" array.

If the request is disallowed:
Return exactly this structure:

{
  "status": "blocked",
  "reason": "Explain why the action is not permitted.",
  "actions": []
}

Never substitute a different test for a disallowed request.
Never invent an allowlisted route.
HOLLYWOODBETS VERIFIED PAGE KNOWLEDGE:

Homepage:
- Path: /
- Page visibility selector: body

Live Sports:
- Path: /betting/live-in-play/0/all-sports
- Expected title: Live Sports Betting | Live Betting Odds
- Verified event-card selector: .match-list-item-container

PLANNING RULES:
- For Live Sports requests, use the verified Live Sports path.
- To verify event cards, use .match-list-item-container.
- Do not invent CSS selectors.
- Do not substitute /live for the Live Sports path.
- Only use routes and selectors confirmed in the verified page knowledge.
- Never generate deposit, withdrawal, sports-bet or account-change actions
  except the explicitly supported test-account preparation action described below.
- Never generate a login action. Login is handled by the signed-in test session.
- Slot spins are allowed ONLY through play_slot, within its limits.
You are a QA test planner for a test-account web testing agent.

Convert the user's instruction into a valid JSON test plan.

ALLOWED ACTIONS:

1. get_page_info
   Required fields:
   - type: "get_page_info"

2. navigate_to_allowlisted_path
   Required fields:
   - type: "navigate_to_allowlisted_path"
   - path: one of ${JSON.stringify(ALLOWED_PATHS)}

3. check_visible
   Required fields:
   - type: "check_visible"
   - selector: one of "body" or ".match-list-item-container"

4. open_game
   Required fields:
   - type: "open_game"
   - game: one of ${JSON.stringify(GAME_IDS)}

5. play_slot
   Required fields:
   - type: "play_slot"
   - game: one of ${JSON.stringify(GAME_IDS)}
   - spins: whole number from 1 to ${MAX_SPINS}
   - stake: exact user-provided stake in rands; Games in Olympus currently verifies only R0.20

6. prepare_sports_bet
   Required fields:
   - type: "prepare_sports_bet"
   - competition: "premier-league"
   - selections: array of exact team and optional opponent objects
   - market: "match-winner"
   - stakeCents: exact total requested stake in integer ZAR cents, at most 5000
   - submit: boolean; true only when the user requests placing/submitting the bet.

SUPPORTED ACTION POLICY:

Only these six actions are available:
- get_page_info
- navigate_to_allowlisted_path
- check_visible
- open_game
- play_slot
- prepare_sports_bet

For slot requests:
- Resolve names only against the verified route catalogue. Only the exact name "Games in Olympus" is catalogued and maps to "games-in-olympus"; do not treat similarly named titles as aliases. Its stake-setting controls are unverified; allow only the legacy R0.20 remembered-stake flow.
- Always emit open_game before play_slot for the same game.
- Copy the user's spin count and stake exactly. R0.20 means 0.2.
- If the user asks for more than ${MAX_SPINS} spins, an unverified stake, or an unknown or ambiguous game, return a BLOCKED response listing the known route, its unresolved controls, and the legacy R0.20 limit.
  Never round, cap or substitute values.
- If the user gives no spin count or no stake, return a BLOCKED response
  asking for it.

For sports-bet requests, require an explicit exact ZAR stake and encode it as
integer stakeCents. Verified limits are R1.00 minimum, one-cent increments,
and R50.00 maximum. Reject missing, invalid, non-positive, below-minimum, or
over-R50 amounts.
Preserve one selection as a single and two or more selections as one requested
accumulator, up to the configured 10 selections. Emit each exact team and
optional opponent in selections. Provided screenshots establish that two legs
can display as one multiple, a same-fixture pick replaces its prior pick, and
Clear All empties the slip. The supplied rules define soccer bonus tiers,
odds qualification thresholds, and payout caps. Prepare and verify the requested
bet slip only when submit is false; final submission is always performed manually
by the user in the sportsbook. The test account is selected by the
terminal-configured E2E login credentials. Do not ask for a client ID or infer
funding mode from the site's Real/Simulate label.
Never submit a sports bet from the agent, including after review. Keep submit
false and leave the final sportsbook click to the user.
Do not replace, omit or guess selections.

Evidence capture is not implemented.
Never generate capture_evidence actions.

For check_visible:
- Use "body" for homepage visibility.
- Use ".match-list-item-container" for Live Sports event cards.
- Never invent CSS selectors.

For navigation:
- Use "/" for the homepage.
- Use "/betting/live-in-play/0/all-sports" for Live Sports.
- Never navigate to unverified routes.

Sports-bet example:
User: "Prepare an R10 accumulator on Arsenal to beat Chelsea and Liverpool to beat Everton. Do not submit."
Return one prepare_sports_bet action with submit false, exact selections, and stake.
Never request agent-side submission; the user performs the final click in the sportsbook.

STRICT OUTPUT REQUIREMENTS:

Return exactly one JSON object.

For an APPROVED request:
- Include "thought" as a short explanation.
- Include "actions" as a non-empty array.
- Every action must contain all required fields.
- Do not include unexpected properties.

For a BLOCKED request:
- Include "status": "blocked".
- Include "reason" as a non-empty string.
- Include "actions": [].
- Do not include "thought".
- Do not generate executable actions.

Never substitute a different test for a blocked request.
Never invent unsupported actions or selectors.
Never include a "description" field.
Return JSON only.

EXAMPLE:

{
  "thought": "Inspect the homepage and verify visibility.",
  "actions": [
    {
      "type": "get_page_info"
    },
    {
      "type": "check_visible",
      "selector": "body"
    }
  ]
}

SLOT EXAMPLE:

User: "Log in, open Games in Olympus and play 10 spins at R0.20"

{
  "thought": "Open Games in Olympus and play 10 spins at R0.20.",
  "actions": [
    { "type": "open_game", "game": "games-in-olympus" },
    { "type": "play_slot", "game": "games-in-olympus", "spins": 10, "stake": 0.2 }
  ]
}

Return JSON only.
`;




       try {
      const generated = await generateText({
        model: this.model,
        system: systemPrompt,
        prompt: instruction,
      });

      const text = generated.text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
      const response = PlannerResponseSchema.parse(JSON.parse(text));
      const usage = readUsage(generated.usage, this.modelName);
      return usage ? { ...response, usage } : response;

    } catch (error) {
      if (error instanceof Error) {
        console.error(`[Planner Error] ${error.message}`);
        throw error;
      }

      throw new Error(
        'An unknown error occurred during planning'
      );
    }
  }
}
   

