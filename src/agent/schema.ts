
import { z } from 'zod';
import { validateSportsStakeCents } from './sports-fixtures';
import { MAX_SPINS } from './slot-safety';

export { MAX_SPINS } from './slot-safety';

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
 * Catalogued casino routes. Stake controls are independently verified per entry;
 * an unverified control method keeps that entry on legacy behavior only.
 */
export const GAME_CATALOGUE = {
  'games-in-olympus': {
    canonicalName: 'Games in Olympus',
    aliases: [],
    route: '/lobby/top-games/#/g/games-in-olympus',
    identifiers: ['vs20olygames', 'Pragmatic Play'],
    // Existing evidence verifies the remembered R0.20 stake and protocol, but
    // not the controls used to change it. Keep the verified legacy amount only.
    stake: { minCents: 20, maxCents: 20, incrementCents: 1, verifiedCents: [20] },
    stakeMethod: 'legacy-remembered-stake; adjustment-controls-unverified',
  },
} as const;

export const ALLOWED_GAMES = Object.fromEntries(
  Object.entries(GAME_CATALOGUE).map(([id, game]) => [id, game.route])
) as { readonly 'games-in-olympus': typeof GAME_CATALOGUE['games-in-olympus']['route'] };

export function resolveGameName(name: string): keyof typeof GAME_CATALOGUE | null {
  const normalized = name.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const matches = Object.entries(GAME_CATALOGUE).filter(([, game]) =>
    [game.canonicalName, ...game.aliases].some((alias) =>
      alias.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') === normalized
    )
  );
  return matches.length === 1 ? matches[0][0] as keyof typeof GAME_CATALOGUE : null;
}

export function validateSlotStake(gameId: string, stake: number): boolean {
  if (!Number.isFinite(stake) || !/^\d+(?:\.\d{1,2})?$/.test(String(stake))) return false;
  const game = GAME_CATALOGUE[gameId as keyof typeof GAME_CATALOGUE];
  if (!game) return false;
  const cents = Math.round(stake * 100);
  return cents >= game.stake.minCents && cents <= game.stake.maxCents
    && (cents - game.stake.minCents) % game.stake.incrementCents === 0
    && (game.stake.verifiedCents as readonly number[]).includes(cents);
}

export const GAME_IDS = Object.keys(ALLOWED_GAMES) as [
  keyof typeof ALLOWED_GAMES,
  ...(keyof typeof ALLOWED_GAMES)[],
];

/** Hard limits for wagering actions. The planner cannot exceed these. */
export const ALLOWED_STAKES = [0.2] as const;

/** Limits supplied by the project owner: R1.00 minimum, one-cent steps, R50 cap. */
export const SPORTS_STAKE_LIMITS = { minCents: 100, maxCents: 5_000, incrementCents: 1 } as const;
/** Maximum accumulator legs supplied by the project owner. */
export const SPORTS_MAX_ACCUMULATOR_SELECTIONS = 10;
export const ALLOWED_SPORT_BET_COMPETITIONS = ['premier-league'] as const;

const OpenGameAction = z.object({
  type: z.literal('open_game'),
  game: z.enum(GAME_IDS),
}).strict();

const PlaySlotAction = z.object({
  type: z.literal('play_slot'),
  game: z.enum(GAME_IDS),
  spins: z.number().int().min(1).max(MAX_SPINS),
  // zod 4: z.literal accepts a list of allowed values.
  stake: z.number().positive().refine((stake) => validateSlotStake('games-in-olympus', stake), 'STAKE_NOT_ALLOWED'),
}).strict();

/** Describes a sports request; chat/runtime evidence gates block unsupported browser work. */
const PrepareSportsBetAction = z.object({
  type: z.literal('prepare_sports_bet'),
  competition: z.enum(ALLOWED_SPORT_BET_COMPETITIONS),
  selections: z.array(z.object({
    team: z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N} .&'’()-]*$/u),
    opponent: z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N} .&'’()-]*$/u).optional(),
  }).strict()).min(1).max(SPORTS_MAX_ACCUMULATOR_SELECTIONS),
  market: z.literal('match-winner'),
  stakeCents: z.number().int().refine(
    (cents) => validateSportsStakeCents(cents, SPORTS_STAKE_LIMITS),
    'SPORTS_STAKE_LIMIT_OR_INCREMENT_INVALID',
  ),
  submit: z.boolean(),
}).strict();

/**
 * General executor action schema.
 * Evidence capture remains defined for future implementation.
 */
export const ActionSchema = z.discriminatedUnion('type', [
  OpenGameAction,
  PlaySlotAction,
  PrepareSportsBetAction,

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
}).strict().superRefine((plan, context) => {
  plan.actions.forEach((action, index) => {
    if (action.type !== 'play_slot') return;
    const opened = plan.actions.slice(0, index).some((prior) =>
      prior.type === 'open_game' && prior.game === action.game
    );
    if (!opened) context.addIssue({ code: 'custom', path: ['actions', index], message: 'GAME_MUST_BE_OPENED_FIRST' });
  });
});

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
    PrepareSportsBetAction,
  ]
);

/** True when a plan places bets and therefore needs login + user confirmation. */
export function isWagerPlan(plan: { actions: readonly { type: string }[] }): boolean {
  return plan.actions.some((a) => a.type === 'play_slot' || a.type === 'prepare_sports_bet');
}

export function isSportsWagerPlan(plan: { actions: readonly { type: string }[] }): boolean {
  return plan.actions.some((a) => a.type === 'prepare_sports_bet');
}

/** True when a plan needs the signed-in session. */
export function needsAuth(plan: { actions: readonly { type: string }[] }): boolean {
  return plan.actions.some((a) =>
    a.type === 'play_slot' || a.type === 'open_game' || a.type === 'prepare_sports_bet'
  );
}

/**
 * Executable plans that the AI may generate.
 */
export const PlannerPlanSchema = PlanSchema;

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
