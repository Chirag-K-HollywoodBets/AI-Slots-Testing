import { z } from 'zod';
import { canonicalTeamName, establishedTeamAliases, establishedTeamName, fixtureMatchesTeams, validateRequestedSelections } from './sports-fixtures';
import type { SportsConversationState, ClarificationRequirement } from './sports-conversation';

export const TeamSuggestionSchema = z.object({
  index: z.number().int().min(0).max(9), field: z.enum(['team', 'opponent']), original: z.string().min(1),
  candidates: z.array(z.string().min(1)).min(1).max(10),
}).strict();
export const FixtureSnapshotSchema = z.object({
  source: z.string().min(1).max(500), observedAt: z.number().int().nonnegative(),
  fixtures: z.array(z.object({ id: z.string().min(1), home: z.string().min(2).max(80), away: z.string().min(2).max(80),
    competition: z.string().min(1).max(80), kickoff: z.string().min(1).max(80) }).strict()).max(5000),
}).strict();
export type FixtureSnapshot = z.infer<typeof FixtureSnapshotSchema>;
export const CompetitionResolutionSchema = z.object({
  competition: z.string().min(1), source: z.string().min(1), observedAt: z.number().int().nonnegative(),
  fixtureIds: z.array(z.string().min(1)).min(1),
}).strict();

/** Only application-supplied, fresh read-only observations qualify as evidence. */
export function usableFixtureSnapshot(input: unknown, now: number): FixtureSnapshot | null {
  const result = FixtureSnapshotSchema.safeParse(input);
  if (!result.success || result.data.observedAt > now || now - result.data.observedAt > 5 * 60_000) return null;
  if (new Set(result.data.fixtures.map((fixture) => fixture.id)).size !== result.data.fixtures.length) return null;
  return result.data;
}

function distance(a: string, b: string): number {
  const grid = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) grid[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + 1);
  }
  return grid[a.length][b.length];
}

export function teamCandidates(value: string, snapshot: FixtureSnapshot | null): string[] {
  const catalogue = new Map<string, string>();
  for (const [alias] of Object.entries(establishedTeamAliases())) catalogue.set(alias, establishedTeamName(alias));
  for (const fixture of snapshot?.fixtures ?? []) for (const team of [fixture.home, fixture.away]) catalogue.set(team.toLowerCase(), establishedTeamName(team));
  const key = canonicalTeamName(value);
  if ([...catalogue.keys()].some((alias) => canonicalTeamName(alias) === key)) return [];
  const matches = [...catalogue].filter(([alias]) => distance(value.toLowerCase(), alias) <= (value.length >= 5 ? 2 : 1)
    || (value.length >= 3 && alias.startsWith(`${value.toLowerCase()} `)));
  return [...new Set(matches.map(([, team]) => team))].slice(0, 10);
}

/** Apply an explicit acceptance/rejection only; suggestions never count as known teams. */
export function answerTeamSuggestions(state: SportsConversationState, message: string): number {
  let answered = 0;
  const remaining = [];
  for (const suggestion of state.teamSuggestions ?? []) {
    const selection = state.request?.selections[suggestion.index];
    if (!selection || selection[suggestion.field] !== suggestion.original) continue;
    const negative = /^(?:no|nope|neither|none|not)\b/i.test(message.trim());
    const named = suggestion.candidates.filter((candidate) => new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message));
    const yes = /^(?:yes|yep|correct|that's right|that is right)\b/i.test(message.trim());
    const uncertain = /\b(?:maybe|perhaps|possibly|not sure)\b/i.test(message);
    const namedAcceptance = named.length === 1 && !uncertain
      && (yes || message.toLowerCase().startsWith(named[0].toLowerCase()) || /\b(?:mean|meant|use|choose|select|it is|it's)\b/i.test(message))
      && (state.teamSuggestions ?? []).filter((item) => item.candidates.includes(named[0])).length === 1;
    const rejected = negative && state.teamSuggestions?.length === 1;
    const accepted = !negative && !uncertain && (namedAcceptance ? named[0]
      : yes && suggestion.candidates.length === 1 && (state.teamSuggestions?.length ?? 0) === 1 ? suggestion.candidates[0] : null);
    if (rejected || accepted) {
      selection[suggestion.field] = accepted || null;
      delete state.fixtureResolutions[String(suggestion.index)];
      if (state.competitionResolution) { state.request!.competition = null; delete state.competitionResolution; }
      answered++;
    } else remaining.push(suggestion);
  }
  if (state.teamSuggestions) state.teamSuggestions = remaining;
  return answered;
}

/** Enrich a draft using aliases and observed fixtures, never model knowledge. */
export function clarifyTeamsAndFixtures(state: SportsConversationState, input: unknown, now: number, message: string): void {
  if (!state.request) return;
  const snapshot = usableFixtureSnapshot(input, now);
  const issues: ClarificationRequirement[] = [];
  const suggestions: z.infer<typeof TeamSuggestionSchema>[] = [];
  state.request.selections.forEach((selection, index) => {
    for (const field of ['team', 'opponent'] as const) {
      const value = selection[field];
      if (!value) continue;
      selection[field] = establishedTeamName(value);
      // Once offered, the suggestion remains pending even if the fixture cache
      // disappears. Another field answer must never implicitly accept a typo.
      const previous = state.teamSuggestions?.find((item) => item.index === index && item.field === field && item.original === selection[field]);
      const candidates = previous?.candidates ?? teamCandidates(selection[field]!, snapshot);
      if (candidates.length) {
        suggestions.push({ index, field, original: selection[field]!, candidates });
        issues.push({ field: `selections.${index}.${field}`, code: 'team_suggestion', question: candidates.length === 1
          ? `Did you mean ${candidates[0]} instead of “${value}” for selection ${index + 1}?`
          : `Which ${field} do you mean for selection ${index + 1}: ${candidates.join(' or ')}?` });
      }
    }
  });
  if (suggestions.length || state.teamSuggestions) state.teamSuggestions = suggestions;
  state.rejectedUpdates = state.rejectedUpdates.filter((issue) => issue.code !== 'team_suggestion'
    && (!snapshot || !['fixture_ambiguous', 'fixture_not_found'].includes(issue.code)));
  state.rejectedUpdates.push(...issues);
  if (!snapshot || suggestions.length) return;
  const resolved: FixtureSnapshot['fixtures'] = [];
  let matchedSelections = 0;
  state.request.selections.forEach((selection, index) => {
    if (!selection.team) return;
    let matches = snapshot.fixtures.filter((fixture) => fixtureMatchesTeams(`${fixture.home} vs ${fixture.away}`, selection.team!, selection.opponent ?? undefined)
      && (!state.request!.competition || fixture.competition === state.request!.competition));
    const previous = state.fixtureResolutions[String(index)];
    const explicit = matches.filter((fixture) => message.includes(fixture.kickoff) || message === fixture.id);
    const chosen = explicit.length ? explicit : matches.filter((fixture) => fixture.id === previous?.fixtureId);
    if (chosen.length === 1) matches = chosen;
    if (matches.length) { matchedSelections++; resolved.push(...matches); }
    if (matches.length > 1) {
      delete state.fixtureResolutions[String(index)];
      state.rejectedUpdates.push({ field: `selections.${index}.fixture`, code: 'fixture_ambiguous', question: !selection.opponent
        ? `Who is ${selection.team} playing? Available fixtures: ${matches.map((f) => `${f.home} vs ${f.away} (${f.kickoff}, ${f.competition})`).join('; ')}.`
        : `Which fixture do you mean: ${matches.map((f) => `${f.kickoff} (${f.competition})`).join(' or ')}?` });
    } else if (matches.length === 1) {
      // Never fill the opponent implicitly, even when one fixture matches.
      if (selection.opponent && validateRequestedSelections([{ team: selection.team, opponent: selection.opponent }],
        matches.map((f) => `${f.home} vs ${f.away}`), 10).ok) {
        const fixture = matches[0];
        state.fixtureResolutions[String(index)] = { fixtureId: fixture.id, fixture: `${fixture.home} vs ${fixture.away}`,
          source: snapshot.source, observedAt: snapshot.observedAt };
      }
    } else if (selection.opponent) {
      delete state.fixtureResolutions[String(index)];
      state.rejectedUpdates.push({ field: `selections.${index}.fixture`, code: 'fixture_not_found',
        question: `I could not match ${selection.team} vs ${selection.opponent} in the verified fixtures. Please check the teams and competition.` });
    }
  });
  const competitions = new Set(resolved.map((fixture) => fixture.competition));
  if (!state.request.competition && matchedSelections === state.request.selections.length && competitions.size === 1) {
    state.request.competition = resolved[0].competition;
    state.competitionResolution = { competition: resolved[0].competition, source: snapshot.source,
      observedAt: snapshot.observedAt, fixtureIds: resolved.map((fixture) => fixture.id) };
  }
}
