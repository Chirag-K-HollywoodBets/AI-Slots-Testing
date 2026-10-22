import {
  PlannerResponseSchema,
  ALLOWED_PATHS,
  GAME_IDS,
  ALLOWED_STAKES,
  MAX_SPINS,
  type PlannerResponse,
} from './schema';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject } from 'ai';

export interface PlannerOptions {
  apiKey?: string;
  baseUrl: string;
  modelName: string;
  // Allow passing a custom model for testing purposes
  customModel?: any;
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
  async plan(instruction: string): Promise<PlannerResponse> {
    
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
- Never generate deposit, withdrawal, sports-bet or account-change actions.
- Never generate a login action. Login is handled automatically for game actions.
- Slot spins are allowed ONLY through play_slot, within its limits.
You are a QA test planner for a read-only web testing agent.

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
   - stake: one of ${JSON.stringify(ALLOWED_STAKES)} (rands)

SUPPORTED ACTION POLICY:

Only these five actions are available:
- get_page_info
- navigate_to_allowlisted_path
- check_visible
- open_game
- play_slot

For slot requests:
- "Games in Olympus" maps to game "games-in-olympus".
- Always emit open_game before play_slot for the same game.
- Copy the user's spin count and stake exactly. R0.20 means 0.2.
- If the user asks for more than ${MAX_SPINS} spins, a stake not in
  ${JSON.stringify(ALLOWED_STAKES)}, or an unknown game, return a BLOCKED response.
  Never round, cap or substitute values.
- If the user gives no spin count or no stake, return a BLOCKED response
  asking for it.

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
      const { object } = await generateObject({
        model: this.model,
        schema: PlannerResponseSchema,
        system: systemPrompt,
        prompt: instruction,
      });

      return PlannerResponseSchema.parse(object);

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
   

