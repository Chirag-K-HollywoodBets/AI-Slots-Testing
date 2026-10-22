
/**
 * Shared types for the HollywoodBets AI Testing Agent.
 *
 * Types are derived from the validated Zod schemas
 * to prevent schema/type mismatches.
 */

import type {
  AgentAction,
  AgentPlan,
  AllowedPaths,
} from './schema';

export type ActionType = AgentAction['type'];

export type ActionPlan = AgentAction;

export type Plan = AgentPlan;

export type PlanType = AgentPlan;

export type AllowedPath = AllowedPaths;

export type Action = AgentAction;