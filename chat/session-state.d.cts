import type { PendingSportsRequest, SportsConversationState } from '../src/agent/sports-conversation';
import type { AgentPlan } from '../src/agent/schema';
import type { PlannerUsage } from '../src/agent/planner';

export interface PendingConfirmation {
  plan: AgentPlan;
  usage?: PlannerUsage;
  expires: number;
  sportsRevision?: number;
  sportsRequestFingerprint?: string | null;
}
export interface ChatSession {
  id: string;
  expiresAt: number;
  pendingSports: PendingSportsRequest | null;
  conversationState: SportsConversationState | null;
  confirmations: Map<string, PendingConfirmation>;
  messages: Array<{ id: string; role: 'user' | 'agent'; text?: string; result?: Record<string, unknown> }>;
}
export function createChatSessions(options?: { ttlMs?: number; maxSessions?: number }): {
  resolve(cookieHeader?: string, now?: number): { session: ChatSession; created: boolean; cookie: string };
};
export function clearSportsConfirmations(session: ChatSession): void;
export function takeConfirmation(session: ChatSession, planId: string, now?: number): PendingConfirmation | null;
export function cancelConfirmation(session: ChatSession, planId: string): boolean;
export function sportsRequestFingerprint(request: PendingSportsRequest | null): string | null;
export function sportsPlanMatchesRequest(plan: AgentPlan, state: SportsConversationState | null): boolean;
export function rememberMessage(session: ChatSession, message: ChatSession['messages'][number]): void;
