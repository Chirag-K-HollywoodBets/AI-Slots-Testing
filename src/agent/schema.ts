
import { z } from 'zod';

/**
 * Verified HollywoodBets routes.
 * Only these routes are currently approved for AI navigation.
 */
export const ALLOWED_PATHS = [
  '/',
  '/betting/live-in-play/0/all-sports',
] as const;

/**
 * Verified selectors for read-only browser checks.
 */
export const ALLOWED_SELECTORS = [
  'body',
  '.match-list-item-container',
] as const;

/**
 * Verified casino games. Key = what the planner may name,
 * value = lobby URL (path + hash route) on the allowed origin.
 */
export const ALLOWED_GAMES = {
  // TODO: confirm this lobby entry really is Games in Olympus (Pragmatic Play).
  'games-in-olympus': '/lobby/top-games/#/g/games-in-olympus',
} as const;

export const GAME_IDS = Object.keys(ALLOWED_GAMES) as [
  keyof typeof ALLOWED_GAMES,
  ...(keyof typeof ALLOWED_GAMES)[],
];

/** Hard limits for wagering actions. The planner cannot exceed these. */
export const ALLOWED_STAKES = [0.2] as const;
export const MAX_SPINS = 10;

const OpenGameAction = z.object({
  type: z.literal('open_game'),
  game: z.enum(GAME_IDS),
}).strict();

const PlaySlotAction = z.object({
  type: z.literal('play_slot'),
  game: z.enum(GAME_IDS),
  spins: z.number().int().min(1).max(MAX_SPINS),
  // zod 4: z.literal accepts a list of allowed values.
  stake: z.literal(ALLOWED_STAKES),
}).strict();

/**
 * General executor action schema.
 * Evidence capture remains defined for future implementation.
 */
export const ActionSchema = z.discriminatedUnion('type', [
  OpenGameAction,
  PlaySlotAction,

  z.object({
    type: z.literal('get_page_info'),
  }).strict(),

  z.object({
    type: z.literal('navigate_to_allowlisted_path'),
    path: z.enum(ALLOWED_PATHS),
  }).strict(),

  z.object({
    type: z.literal('check_visible'),
    selector: z.enum(ALLOWED_SELECTORS),
  }).strict(),

  z.object({
    type: z.literal('capture_evidence'),
    reason: z.string().min(1),
  }).strict(),
]);

/**
 * General plan schema used by the executor.
 */
export const PlanSchema = z.object({
  thought: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
}).strict();

/**
 * AI planner actions.
 * Only currently implemented read-only operations.
 */
export const PlannerActionSchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('get_page_info'),
    }).strict(),

    z.object({
      type: z.literal('navigate_to_allowlisted_path'),
      path: z.enum(ALLOWED_PATHS),
    }).strict(),

    z.object({
      type: z.literal('check_visible'),
      selector: z.enum(ALLOWED_SELECTORS),
    }).strict(),

    OpenGameAction,
    PlaySlotAction,
  ]
);

/** True when a plan places bets and therefore needs login + user confirmation. */
export function isWagerPlan(plan: { actions: readonly { type: string }[] }): boolean {
  return plan.actions.some((a) => a.type === 'play_slot');
}

/** True when a plan needs the signed-in session. */
export function needsAuth(plan: { actions: readonly { type: string }[] }): boolean {
  return plan.actions.some((a) => a.type === 'play_slot' || a.type === 'open_game');
}

/**
 * Executable plans that the AI may generate.
 */
export const PlannerPlanSchema = z.object({
  thought: z.string().min(1),
  actions: z.array(PlannerActionSchema).min(1),
}).strict();

/**
 * Explicit refusal response.
 */
export const RefusalSchema = z.object({
  status: z.literal('blocked'),
  reason: z.string().min(1),
  actions: z.tuple([]),
}).strict();

/**
 * The planner returns either an executable plan
 * or a refusal.
 */
export const PlannerResponseSchema = z.union([
  PlannerPlanSchema,
  RefusalSchema,
]);

export type PlannerResponse =
  z.infer<typeof PlannerResponseSchema>;

export type AllowedPaths =
  typeof ALLOWED_PATHS[number];

export type AgentAction =
  z.infer<typeof ActionSchema>;

export type AgentPlan =
  z.infer<typeof PlanSchema>;
