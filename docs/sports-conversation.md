# Sports preparation conversation contract

This contract collects a request before any preparation runner can start. Preparation remains separate from the explicit post-review Submit bet control.

## Fields and interpretations

`src/agent/sports-conversation.ts` defines strict Zod schemas and inferred TypeScript types for the pending request and six interpretation kinds: `new_request`, `answer_to_clarification`, `correction`, `cancellation`, `unrelated_message`, and `ambiguous_interpretation`.

A draft contains selections (team and opponent per leg), one competition, one market and one total stake in integer cents. Every unknown field is `null`. A draft is distinct from an executable plan. The existing executable action schemas and browser adapter are unchanged.

The local LLM extracts updates, with verbatim values and supporting quotes from the current message. The pure `transitionSportsConversation(state, event, now)` function validates and merges those updates independently of the LLM and browser. Time is an explicit input. It never obtains missing details from team knowledge, earlier examples, the sportsbook UI or remembered amounts.

- With no pending request, a new request starts a fresh draft. With an existing draft, replacement must be explicit (`New request: …`, `start over`, or `replace my request`). A possibly new request preserves the draft and asks whether to replace or correct it; it invalidates an older confirmation while intent is unresolved.
- An answer fills unknown fields. A conflicting supplied value needs explicit correction intent.
- A correction updates the specified fields and retains all other details. It increments the request revision and invalidates older sports confirmations, requiring a fresh summary. Changing team or opponent also removes that leg's fixture resolution; changing competition removes every fixture resolution. Fixture enrichment uses only a supplied read-only snapshot.
- Team clarification can read an application-supplied fixture snapshot, as described below. It never looks up fixtures through a browser or the model.
- An unrelated message preserves the draft, its revision and its idle deadline. An ambiguous interpretation does not apply field changes. A textual `yes` cannot start a run.
- Cancellation discards the draft and invalidates its sports confirmations. The Cancel button also invalidates its plan on the server.

`Team to beat opponent` and `team to win` explicitly supply match-winner intent. `Team vs opponent` supplies no market. Competition must be supplied even when a team's league appears obvious. Full time alone describes a period and is not assumed to mean match winner.

Stakes are collected in ZAR. A bare numeric message may answer an outstanding stake question; a number elsewhere is not treated as a stake without explicit stake wording or currency. The existing R1.00 minimum, R50.00 cap and one-cent increment rules validate proposed amounts. Invalid amounts are rejected while other valid details from the same message are retained. If a correction proposes an invalid amount, a previously valid amount may remain visible, but an outstanding stake requirement prevents a summary until it is explicitly corrected. Unsupported competitions and markets remain explicit and require correction; supported defaults are never substituted.

Every clarification returns structured `requirements` containing a field path, code and targeted question. Missing opponent, unsupported competition, malformed stake and conflicting answers can therefore be handled individually. Invalid grounding or an ambiguous selection target applies no field changes.

## Confirmation and compatibility

The chat page displays a stage indicator for clarification, awaiting confirmation, running preparation and manual review. Each reply appears as a new message, and earlier questions and summaries remain visible. Team, opponent, competition, market, bet type and total stake are labelled in the summary. Completing the last field displays this summary; it does not open a browser.

`GET /api/conversation-state` restores up to 100 user/agent messages for the existing cookie session, including provider-reported usage. History lives in the same bounded in-memory session store as the draft, expires with the session and is cleared on server restart. It is not sent as full model history. The browser uses text nodes and `textContent` for user messages, questions, summaries and model names, never HTML interpolation. `chat/client.js` is served as a same-origin script under the page's content security policy.

Responses include a session-owned conversation view and active confirmation IDs. Corrections retire the old buttons without deleting the old summary. Expired controls are disabled automatically; stale and already-consumed IDs are rejected by the server. Sports confirmation checks both the exact saved request and its revision, alongside the existing session and expiry checks. Only a button click posts to `/api/confirm`; a final detail or textual yes cannot execute. The server rechecks its busy lock after reading request bodies and blocks new requests throughout preparation and review. Review status and usage are visible only to the owning session.

When every required field is known and valid, the pure transition returns `READY_FOR_SUMMARY` with an empty actions array. Completeness never executes a plan. The separate adapter validates a preparation plan against `PlannerPlanSchema`, with `submit: false`, and records the summary's revision and deadline. The chat displays selections, competition, market and total stake using the existing **Confirm and run / Cancel** controls. Only Confirm and run hands the plan to the existing preparation review runner. In review, **Submit R{stake} bet** and **Finish without submitting** are separate controls. Ordinary messages, generated model output, preparation confirmation and review completion cannot submit.

## Submission lifecycle and current live block

`/api/submit-review` accepts only the owning session, matching review ID and request revision, active/unexpired review, server-read slip fingerprint and server-minted idempotency key. A process-local state machine consumes the authorization before dispatching a command to the waiting runner. The command binds the chat session, review, run, revision, expiry, fingerprint and authorization; the runner returns only a sanitized result file and the server waits at most 25 seconds. Request-body slip values are ignored. On restart, in-memory authorization is lost. Any timeout after possible dispatch is an unknown result and is never retried automatically.

Submission transport is disabled unless the server is explicitly started with `ENABLE_SPORTS_SUBMISSION=1`. The switch is intended only for this PoC's dedicated test account, as confirmed by the project owner; it does not require an account-greeting or funding-type check and must not be copied into unrelated browser sessions. The runner is configured by the server-created review decision/result files. Final submission clicks use the exact scoped selector in `src/agent/adapters/sportsbook-contract.ts`, require one visible and enabled match, and occur only after a fresh live-slip comparison. Missing market/odds/stake/payout or accumulator bonus/final-odds evidence stops the click. No receipt selector is currently established, so an attempted click normally remains acceptance-unverified. Additional confirmation/changed-odds pages stop for manual attention.

The server transport defaults off. When explicitly enabled, the runner may perform the one final click authorized by the chat endpoint. The existing guard remains installed through preparation and review and is removed only after the live slip and unique enabled control have been checked. The verified selector is the scoped Submit control, `[data-testid="betslip-container"] button[data-testid="submit-btn"]`. The read-only traces in `.e2e/slip-inspection-findings.md` and `.e2e/slip-continuous-findings.md` establish only the live slip fields and Submit state. They contain no immediate receipt, bet reference, acceptance text, or explicit rejection. No historical My Bets entry was available to inspect, and historical My Bets markup must not be treated as an immediate receipt. Therefore this checkout has no verified acceptance or rejection selectors or message formats; all post-click results remain unknown. The runner arms a generic DOM mutation observer before the single click to retain transient screen text and stops it on every exit path. It recognizes the existing additional-confirmation/changed-odds guard text but deliberately does not infer acceptance or rejection from generic page text. A future detector requires sanitized immediate-receipt and rejection evidence plus verified reference format and selector mapping.

The runner observes for at most 30 seconds after dispatch, polling captured mutations at the contract's 250 ms interval. The server allows 60 seconds for pre-dispatch revalidation, click/transport overhead, and the runner observation. Authorization expiry is checked before dispatch; it does not truncate observation once a click may have been dispatched. An expiry before dispatch blocks the click. A result that appears after the server's unknown response can reconcile only when review, run, and authorization identifiers match the same process-local attempt. Reference shape validation is only input sanitization and does not establish that a reference is valid. The server's provider evidence verifier defaults to disabled, so neither accepted nor rejected runner claims are trusted in production today. Cleanup and older polling do not replace a verified result. A server restart discards the authorization and reconciliation state; recovery across restarts is unsupported and there is no automatic resubmission.

Result meanings: **accepted** requires explicit acceptance evidence and a valid nonempty bet reference (not currently available from verified sportsbook evidence); **rejected** requires explicit rejection correlated to the attempt (also unavailable); **unknown** means a possible attempt with unverified outcome, including missing/conflicting evidence, disconnect, timeout, or unsupported confirmation. Only accepted results display the reference, confirmed stake, and selections. Acceptance does not imply settlement or a win. Mocked detector and server tests prove the contract only; they are not live sportsbook observations.

Accumulator base odds use the supplied fractional formula `product(legOdds + 1) - 1`. For 3.00 and 1.95 this is 10.80; if the sportsbook actually displays an applied 2.5% bonus, final odds are 11.07 and R10 × 11.07 = R110.70 payout. The adapter currently only reads the existing leg selection odds, Stake and Payout labels. It does not claim to have read sportsbook base odds, bonus qualification, final odds, payout basis, or odds-change preference. Such accumulator reviews show calculated base odds, the displayed payout, and the other fields as unverified; no profit is inferred. The 0.65 single remains R6.50 payout at R10.

Manual acceptance is a separate, explicitly authorized step for the project owner on the dedicated test account. First keep `ENABLE_SPORTS_SUBMISSION` unset and verify the chat reports it unavailable. Before enabling it, inspect and sanitize the immediate receipt from an already-authorized low-value test submission and a historical My Bets entry independently, recording the real acceptance text, reference field, stake/selections, and explicit rejection evidence where available. Do not place another bet just to collect evidence. Update centralized selectors only from those observations and add sanitized fixtures. Then, with separate authorization, configure the isolated test account and start the server with `ENABLE_SPORTS_SUBMISSION=1`; prepare the approved test slip, inspect the exact snapshot, and click **Submit** once. Confirm no follow-up click occurs on unknown or changed terms. Reconcile My Bets manually before any further attempt. Do not treat mocked tests as sportsbook acceptance.

### Staged manual acceptance checklist

1. Run unit tests and typecheck; use mocked browser and sportsbook boundaries only.
2. Confirm a request and prepare a slip. Check selections, competition, market, bet type, stake, displayed odds, payout and bonus details in chat.
3. Verify Finish without submitting closes the review without calling the submission boundary.
4. With mocks, exercise changed stake/odds/payout/selections, unreadable values, review expiry, stale revision, wrong session, duplicate/concurrent clicks, cancellation, disconnect, explicit rejection, accepted receipt, missing/malformed references, stale/conflicting receipt evidence, timeout, and late result reconciliation. An unknown result must direct reconciliation and must not retry.
5. Reload during ready review and verify controls recover from server state. Simulate restart and verify old authorization is invalidated and no automatic retry occurs.
6. Do not click a live Submit control during implementation or mocked testing. A separately authorized test must first establish the missing receipt/reference and rejection evidence above.

Browser messages carry a message ID. Repeated IDs and immediately repeated text return `UNCHANGED`, creating no duplicate plan or confirmation. The state retains up to 64 receipts, including through cancellation and explicit replacement. Confirmation IDs are consumed once and bound to their conversation revision; an old revision cannot authorize preparation even if its map entry remains.

Slot and approved read-only commands retain the original planner/execution path. They do not consume a sports draft. The legacy planner cannot bypass this contract by emitting an unexpected sports action.

Example conversation:

1. `Prepare Arsenal to win.` — team and market known; opponent, competition and stake unknown.
2. `Chelsea, Premier League.` — opponent and competition saved; stake still unknown.
3. `R10.01 total.` — complete summary shown; no browser run yet.
4. `Change the stake to R20.` — a fresh summary replaces the previous authorization opportunity; the old confirmation ID is invalid.
5. **Confirm and run** — authorizes preparation only.

For several legs, replies identify which selection they update. Selection removal or replacing an entire accumulator can be expressed as a new request; unclear references require clarification.

## Session boundary

The original server had no chat sessions and stored confirmations globally. `chat/session-state.cjs` now creates an opaque, server-issued `hb_chat_session` cookie with HttpOnly and SameSite=Strict. Drafts and confirmation plans are stored per session. A session cannot read, confirm or cancel another session's plan, even with its plan ID. Review access is bound to its originating chat session as well.

The cookie defines a browser session: tabs in the same browser profile share it; separate profiles or private sessions do not. In-memory drafts expire after 30 minutes without a relevant update and reset when the server restarts. Expiry clears the request, fixture resolutions and confirmation; a later short answer cannot revive them, even if misinterpreted as a new request. The store is bounded to 1,000 sessions. Confirmation plans retain their existing two-minute lifetime and are consumed once. Both timeouts are shared through `chat/timeouts.cjs`, and expiry applies at the exact deadline. The existing process-wide execution lock remains because the browser runner is shared.

Persistent storage or independent conversations within one browser profile would require an additional storage/conversation-ID design; neither is needed for this contract.

## Team names, spelling suggestions and fixture evidence

The established alias table in `sports-fixtures.ts` is the deterministic authority for names such as `Manchester City` and `Man City`. Both are stored as `Man City`. Unknown spellings are compared only with that alias catalogue and team names in a fresh verified fixture snapshot. A transposition such as `Man Ctiy` offers `Man City`; it does not silently change the selected team.

`teamSuggestions` is session-owned structured state containing the selection index, team/opponent field, original spelling and candidate names. A pending suggestion blocks completeness and confirmation. `Yes` accepts exactly one pending suggestion with exactly one candidate. A named answer can select one option. `No` rejects a single suggestion and clears that field while preserving other supplied details. An untargeted yes/no cannot select between several candidates or several pending suggestions. Suggestions survive temporary fixture-source loss, and cancel/expiry discards them. A combined reply such as `Yes, Man City, and R10` accepts the offered name and merges the stake in the same turn. This consent concerns the spelling only; preparation still requires the existing Confirm and run button.

The repository currently obtains live sportsbook fixtures inside the preparation browser path. Conversation collection does not reuse that path or open an authenticated browser. If a separate trusted read-only collector maintains a local snapshot, configure `SPORTS_FIXTURE_SNAPSHOT_PATH` in the chat server's terminal environment before starting it. No source is configured by default. The application reads this file; neither user messages nor the LLM can provide fixture evidence or set its path.

Snapshot JSON has this shape:

```ts
{
  source: string;       // identity of the trusted collector/feed
  observedAt: number;   // actual observation time, Unix milliseconds
  fixtures: Array<{
    id: string;
    home: string;
    away: string;
    competition: string; // canonical competition key, e.g. premier-league
    kickoff: string;     // displayed date/time identifying this fixture
  }>;
}
```

The cache must come from actual verified observations, never model-generated fixtures. The reader rejects malformed snapshots, duplicate IDs, future observation times, snapshots older than five minutes, files over 1 MB and reads taking longer than one second. Missing or unavailable data is a normal fallback: ask for unknown opponent/competition and defer final fixture verification to the existing preparation path. Fully supplied requests can still reach the confirmation summary without a cache.

Verified fixture matching reuses `fixtureMatchesTeams` and `validateRequestedSelections`. It never populates an opponent automatically. Multiple possible opponents or fixtures produce targeted questions, with the observed options and kickoff times. A competition is inferred only when all selections match verified data and the competition is unique; `competitionResolution` records its source, observation time and supporting fixture IDs. Individual unique fixture resolutions also carry provenance. Changing a team or opponent clears a competition inferred from the old fixture; explicitly supplied competition is retained. A stale or unavailable cache cannot supply new resolutions. Browser preparation continues to perform its own final validation under the existing safeguards.

## Verification

### Local model interpretation

`src/agent/sports-interpreter.ts` connects the existing `Planner` local-model connection to the pure conversation transitions. The input contains the current message, the active pending request, the first outstanding application-generated clarification (field and question), and at most one previous user reply, capped at 500 characters. Older facts come from the structured draft. Expired draft details, confirmation tokens and fixture resolutions are excluded. No additional global history is stored or shared between sessions.

Interpretations are separate from executable plans. Strict schemas reject extra fields and unsupported kinds; runtime checks reject invented evidence, duplicate selection targets, conflicting monetary amounts and correction/cancellation classifications without explicit intent. User text is serialized as input data and cannot grant execution authority. Only deterministic collection may create a confirmation summary, and only the existing confirmation endpoint may start preparation.

Generation has a 60-second deadline, an abort signal and no automatic retries. A deadline also bounds providers that ignore abort. Invalid JSON, schema failures, service failures and timeouts return a recoverable clarification with empty actions and preserve the draft, revision and confirmation. Missing details are ordinary clarification requirements. Model-written questions are never displayed; the application supplies the wording. Standalone short answers without an active draft do not call the model and cannot create a plan. Explicit cancellation continues to work without the model service through the chat planning entry point.

### Manual check without opening the sportsbook

Keep the existing terminal `LLM_URL` and `LLM_MODEL` settings, then start `node chat/server.cjs` and open `http://127.0.0.1:3001`.

1. Send `Prepare Man City to win`. Expect a question about the opponent, with competition and stake still unknown.
2. Reply `Brighton`, then `Premier League`, then `R10`. Expect the existing **Confirm and run / Cancel** summary, retaining all supplied details.
3. Send `Actually, make it R20`. Expect a fresh R20 summary and invalidation of the previous confirmation.
4. Click **Cancel**. Then send `R10` or `Brighton`. Expect a request to start a new sports preparation conversation.
5. Try `Prepare Man City to beat Brighton in Premier League for R10`. Expect a complete summary directly. Click **Cancel**.

Do not click **Confirm and run** during this interpretation-only check: it starts browser preparation. Stopping at the summary and cancelling opens no sportsbook browser and places no bet. If you control the local model service, temporarily stop it while keeping the chat server running, reply to an active draft, then restore the service and retry. Expect the failure to retain saved details. Changing terminal connection settings requires restarting the chat server, which clears its in-memory sessions.

Pure transition tests cover missing stake → `R10`, missing opponent → `Brighton`, `Actually, make it R20`, invalid then corrected stakes, cancellation, expiration followed by a short answer, unrelated replies, ambiguous replacement, and correction after a generated summary. They also cover fixture invalidation, duplicate receipts and exact timeout boundaries. Stubbed HTTP tests exercise confirmation, deduplication and session isolation without an LLM call or browser run. Browser execution and sportsbook preparation tests remain unchanged.

The [README acceptance checklist](../README.md#manual-acceptance-checklist--conversation-only) covers exact conversations A–E, including sentence punctuation and `Yes, R10.`. `tests/chat/sports-acceptance.test.ts` exercises the real Planner's schema/grounding validation through HTTP while mocking model generation and preparation. Interpreter expiry is rechecked after generation so a request cannot be revived by a slow model reply. Explicit cancellation is also handled before model generation. Single-slip adapter, review validation and client regressions preserve 0.65 × R10 = R6.50 payout, with no added stake and no single-slip profit line.

Run `pnpm test:unit` and `pnpm typecheck`. Live local-model phrasing and browser preparation runs are separate integration checks.
