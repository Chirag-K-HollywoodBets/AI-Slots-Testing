# AI Sports and Slots Testing PoC

## What this is

An AI-driven E2E test proof of concept. A chat request becomes a validated plan and a human confirms it before authenticated browser actions. The known slot route is Games in Olympus. Its existing R0.20 path checks the remembered stake, each spin's reported stake, and balance progression, but it cannot adjust the stake because those controls and limits have not been verified. Other game titles and stake amounts are blocked until their routes, identities, limits, and stake controls are verified. Sports stake rules are configured as R1.00 minimum, one-cent increments, and R50 maximum; the app caps accumulators at 10 requested selections. User-provided screenshots document two-leg multiple display, same-match replacement, Clear All behavior, and bonus/payout fields. Supplied terms define soccer-multiple bonus tiers, odds qualification thresholds, and payout caps. The sports path prepares a verified slip for review; this PoC assumes its isolated browser uses the dedicated test account.

## Prerequisites

- Node.js 24 or newer
- pnpm 12.14.0
- Microsoft Edge
- Access to the internal model server configured for this project

## Setup

```powershell
pnpm install
```

Start Edge with a clean profile and remote debugging enabled:

```powershell
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -WindowStyle Hidden -ArgumentList '--remote-debugging-port=9223', "--user-data-dir=$env:TEMP\edge-e2e-clean", '--no-first-run'
Start-Sleep 3
Invoke-RestMethod http://127.0.0.1:9223/json/version
```

Set the test account credentials in the same terminal used to start the chat server:

```powershell
$env:E2E_USER_HB_TEST_USERNAME = "<test-account-username>"
$env:E2E_USER_HB_TEST_PASSWORD = "<test-account-password>"
$env:E2E_TELEMETRY_DISABLED = "1" # optional
```

The username and password above identify the account used to create the authenticated E2E session. No separate client/account ID is required. The site's Real/Simulate label and whether the account has test credits are not used to decide whether to prepare a wager. Credentials must remain in the local terminal environment and out of prompts, chat output, source code, and logs.

## Run

Run `pnpm test:unit` for the agent and chat unit tests, and `pnpm typecheck` for TypeScript validation. `pnpm test` also runs the unit suite. CI runs both checks without opening a browser or placing wagers.

Sportsbook markup and control timeouts are centralized in `src/agent/adapters/sportsbook-contract.ts`. Preparation verifies each added leg and refuses a nonempty slip on retry. Failure reports include `addedSelections` (verified additions), `attemptedSelections` (clicks that may have reached the page), and `remainingSelections` (the final read, or `null` if unreadable). Inspect and manually clear a partial slip before retrying.

A ready slip requires an exact readable stake and a valid displayed payout. For accumulators, base odds use the sportsbook's fractional formula: multiply each displayed leg odds plus one, then subtract one. The reviewed payout remains the sportsbook's displayed amount; when base/bonus/final odds or payout basis are not separately readable, bonus and payout basis remain unverified and profit is omitted. The single rule remains displayed odds × stake: 0.65 × R10 = R6.50 payout.

```powershell
node chat/server.cjs
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001), send `Log in, open Games in Olympus and play 10 spins at R0.20`, review the canonical game, spin count, stake per spin, and maximum total stake, then select **Confirm and run**. The game must already remember R0.20 with ante off; unsupported remembered stakes stop before the first spin.

Sports requests collect every team, opponent, competition, market and one exact total stake before confirmation. Missing details are asked for across replies; they are never defaulted. Amounts from R1.00 through R50.00 in one-cent increments pass stake validation. The app caps accumulators at 10 selections. For the supplied two-leg example, (3.00 + 1) × (1.95 + 1) − 1 = 10.80 base odds; an observed 2.5% bonus yields 11.07 final odds and R110.70 payout on R10. The bonus is never assumed. The single-slip rule remains **0.65 × R10 = R6.50 payout**, without adding stake or labelling profit. The chat provides Submit R{stake} bet and Finish without submitting. Accumulator submission remains disabled while the bonus/final-odds/payout evidence is unreadable. Single submission is available only with explicit opt-in runner configuration and a live verified slip; missing receipt evidence means acceptance is unverified. Mocked tests never place a live bet.

Example prompts:

- Preparation only: `Prepare an R10 Premier League accumulator on Arsenal to beat Chelsea and Liverpool to beat Everton. Do not submit.`
- Single selection: `Prepare a single R10 Premier League match-winner bet on Arsenal to beat Chelsea. Do not submit.`

The preparation prompt starts the review flow after explicit confirmation. The chat exposes Submit R{stake} bet and Finish without submitting. Submission is opt-in for the dedicated test-account PoC: start the server with `ENABLE_SPORTS_SUBMISSION=1` only when its isolated browser runner and test-account credentials are configured. This setting is explicit and does not opt other browser sessions into submission. The chat sends a single-use authorization through the review decision file; the waiting runner re-reads the live slip and only then can click the uniquely scoped, visible, enabled `[data-testid="betslip-container"] button[data-testid="submit-btn"]`. Missing or changed slip data and a disabled button stop before clicking. With no verified receipt selector, the result is reported as an attempted submission with acceptance unverified; check My Bets before trying again. Development validation uses a mocked browser boundary and must never click a live Submit control.

Incomplete sports requests now collect missing details across replies. For example, `Prepare Arsenal to win` leaves opponent, competition and total stake unknown; reply with those details to receive the confirmation summary. `Cancel` discards the sports draft, and an explicit correction replaces only the named details. See [the conversation contract](docs/sports-conversation.md) for schemas, session boundaries and examples.

The chat labels clarification, awaiting confirmation, running preparation and manual review separately. Earlier messages survive page reloads within the same session. Completing the final detail only shows a summary; it never starts preparation. Corrections replace the active confirmation controls while retaining the earlier summary in the conversation. Confirm and run authorizes preparation only. Submission requires a separate explicit chat button bound to the reviewed slip; ordinary messages and model output cannot authorize it.

## Conversation flow

Request → clarification questions and answers → complete validated summary → **Confirm and run / Cancel** → sportsbook preparation → chat review → explicit **Submit R{stake} bet / Finish without submitting** → attempted/verified outcome. Arriving at a complete request never starts preparation. `Confirm and run`, ordinary messages, and model output cannot submit.

- The supported sports flow is Premier League match winner, one single or one accumulator of up to 10 selections. “To beat” and “to win” explicitly supply match-winner intent.
- Established aliases such as `Manchester City` and `Man City` resolve deterministically. `Man Ctiy` stays unconfirmed until an offered correction is accepted. A single suggestion can be accepted together with another answer, such as `Yes, R10.`.
- Competition may be inferred only from fresh verified fixture observations with recorded provenance. No read-only feed is configured by default. Without one, the chat asks for competition/opponent and preparation verifies the fixture later. See [the optional snapshot contract](docs/sports-conversation.md#team-names-spelling-suggestions-and-fixture-evidence).
- Confirmations expire after two minutes and are bound to the exact request, its revision and the browser session. Corrections invalidate older confirmations. Repeated messages do not create another executable action.
- Drafts expire after 30 minutes without a relevant update. Cookie sessions also expire after 30 minutes of inactivity. History contains the latest 100 messages and is cleared on session expiry or server restart. Tabs in one browser profile share a session; use a private window or another profile to test isolation.

## Manual acceptance checklist — conversation only

Start `node chat/server.cjs` with the existing `LLM_URL` and `LLM_MODEL` terminal settings, then open [the local chat](http://127.0.0.1:3001). These checks stop at the summary: **do not click Confirm and run or Submit**. Edge and sportsbook login are not needed for clarification or summary generation. Send `Cancel.` between independent cases, or use a fresh private browser session.

| Case | Messages | Expected result |
| --- | --- | --- |
| A | `Prepare Man City to beat Brighton in the Premier League.` → `R10.` | Ask only for total stake, then show Man City vs Brighton, Premier League, Match winner, Single and R10.00 with Confirm and run / Cancel. No preparation starts. |
| B | `Place a R10 bet on Man City to win.` → `Brighton.` | Ask for opponent and any unresolved competition. After Brighton, ask only for remaining details. If competition remains unknown, reply `Premier League.`. Show the summary only when complete. A verified unique competition may remove that question; the opponent is never filled automatically. |
| C | `Prepare Man Ctiy to beat Brighton in the Premier League.` → `Yes, R10.` | Offer Man City as an unconfirmed spelling suggestion and ask for stake. The combined answer accepts that one suggestion and supplies R10. Show the corrected Man City summary. |
| D | After any complete summary: `Actually, make it R20.` | Keep earlier messages, retire the old controls, and show a fresh R20 summary. Only its new confirmation is active. |
| E | After clarification or a summary: `Cancel.` | Clear the pending draft and active sports confirmation. A later `R10.` cannot revive it. Old confirmation IDs are rejected by the automated tests. |

- [ ] A–E show the expected questions, details and stage indicator; earlier messages remain visible, including after reload within the same session.
- [ ] Try `R0`, `R0.99`, `R50.01`, `R1.001` and `-R5` while stake is missing. Each stays in clarification and retains the teams, competition and market. Correct with `R10.`. Separately check R1.00, R1.01 and R50.00 reach a summary.
- [ ] Leave a typo suggestion unaccepted and provide only a stake. It must remain in clarification. Reply `No` to reject a single suggestion; the team must become unknown while other details remain saved.
- [ ] With actual verified fixture data containing multiple matches, expect a targeted fixture/opponent/date question. With no read-only source, expect missing-detail questions and deferred final fixture verification. Do not invent a snapshot to claim live fixture verification.
- [ ] Reply with an unrelated message while collecting stake; then send `R10.`. The saved request must be preserved. Repeat the final answer; no second preparation or confirmation is created.
- [ ] Let a confirmation expire for two minutes: its controls must retire. Use `New request: …` for a fresh summary. After a draft/session expires, a short answer must ask to start again, not restore the old request.
- [ ] If you control the configured model service, temporarily stop it while the chat server stays running. A detail answer must show a recoverable error without losing saved details. `Cancel.` must still work. Restore the service and retry a pending detail. Automated tests cover malformed output and timeouts without requiring a live service.
- [ ] In a second private session, send `R10.` or `Brighton.`. Neither can complete the first session's request, expose its history, or authorize its confirmation.
- [ ] Provider token counts remain visible when reported; user text, questions and model names render as literal text.

`tests/chat/sports-acceptance.test.ts` runs the exact A–E wording through the real interpreter, schemas, transitions and HTTP routes with mocked model generation and browser boundaries. Other unit suites cover expiry during interpretation, stale/repeated confirmation, busy races, schema failures, fixture ambiguity, session ownership and the R6.50 single payout. Mocked preparation calls in tests never open a sportsbook browser.

## Optional preparation review check

1. Start the chat server with the designated test-account username and password configured in the local shell; never place credentials in a prompt.
2. Send either complete example above. Missing details stay in clarification; invalid stakes are rejected before a browser run. Only if you separately choose to verify browser preparation, select Confirm and run on a valid summary to start the review run.
3. Confirm R1.00, R1.01, and R50.00 pass stake validation. Browser preparation verifies exact selections, bet type, stake, and displayed payout.
4. Review the prepared betslip in the browser. **Do not click Submit during acceptance testing.** Use Finish without submitting to close the review. A single at displayed odds 0.65 with R10 stake must show R6.50 payout, never R16.50 or R6.50 profit. The automated mocked adapter and client tests verify this without a live browser.

The review timeout defaults to five minutes. Set `SPORTS_REVIEW_TIMEOUT_MS` before starting the chat server to change it; values are bounded to 30 seconds through 10 minutes.

The chat shows per-request input, output, and total token usage when the configured model provider returns usage metadata. These are provider-reported counts for the planning request (not browser execution); providers that omit usage metadata show no token count. The model name is included when counts are available.

## Conversation troubleshooting

| Symptom | What to check |
| --- | --- |
| Still asking for competition after `Brighton.` | This is expected without verified fixture evidence. Reply `Premier League.`; team names alone do not establish competition. |
| Still asking about `Man Ctiy` | A suggestion is not an accepted team. Use `Yes` for a single unambiguous suggestion, name one offered option, or `No` to supply another team. With several pending suggestions, identify the selection and field. |
| Local model unavailable, timed out, or returned invalid output | Check the chat terminal's `LLM_URL` and `LLM_MODEL` and the configured service. The interpreter has a 60-second deadline. Timeouts and service failures have distinct messages. Existing drafts remain unchanged and nothing executes; retry the detail after recovery. If the first request failed before creating a draft, resend the full request instead of a bare detail. Restarting the chat server clears drafts and history. |
| Confirmation expired, already used, or unknown | Use the latest unexpired summary from the same browser session. After expiry, start with `New request: …`. Do not reuse old IDs or expect textual `yes` to start preparation. |
| Repeated message says it was already handled | Use the existing active summary, provide an explicit correction, or cancel and start a new request. This prevents duplicate actions. |
| Another test is running | Wait for the active preparation/review to end. Finish without submitting closes a review without placing a bet; a second request cannot bypass the server's busy guard. |
| Fixture source unavailable | The optional `SPORTS_FIXTURE_SNAPSHOT_PATH` must reference a trusted read-only cache. Missing, malformed, future-dated, older-than-five-minute or stalled snapshots are unavailable. Missing fields must be supplied; final fixture checks remain in preparation. |
| Picks were added but preparation failed | Inspect the reported failed stage and partial-slip details. Manually check and clear any partial slip before retrying. Preparation refuses a nonempty slip rather than silently replaying picks. Do not fix a browser verification failure by changing the conversation's payout rules. |
| No token counts | Counts are shown only when the provider reports valid usage metadata. Missing counts do not imply zero usage or an execution failure. |
| An older page shows outdated controls | Reload after restarting the chat server. History and active controls are restored only from the current server session; a restart intentionally clears them. |

Current limits: Premier League match winner only; 10 accumulator legs; R1–R50 total stake; one in-memory browser session per profile. No independent read-only live fixture feed is bundled, and no live-model/browser acceptance run is implied by the mocked test suite. Final fixture availability and sportsbook controls are checked during preparation. The single-use server-to-runner submission protocol is wired; live acceptance has not been tested.

## Midscene slot inspection (read-only)

The sportsbook continues to use E2E. A separate Midscene script attaches to the Edge instance on port 9223 and opens Games in Olympus in a new tab. It only asks Midscene to inspect the visible game UI; it does not click, type, change stake, or spin. A Playwright route is installed before navigation and aborts requests identified as `doSpin`.

Midscene requires a model adapter family and an image-capable model. Set its model environment variables in PowerShell using values approved for your local model endpoint; do not commit API keys:

```powershell
$env:MIDSCENE_MODEL_BASE_URL = "http://10.6.49.95:8007/gemma/v1"
$env:MIDSCENE_MODEL_NAME = "Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf"
$env:MIDSCENE_MODEL_FAMILY = "qwen3-vl"
$env:MIDSCENE_MODEL_API_KEY = "<local API key, if required>"
```

The script defaults to the Qwen vision adapter for canvas inspection. If the
model server owner confirms that this deployment should use the generic Qwen
adapter instead, set `MIDSCENE_MODEL_FAMILY` to `qwen` in the shell before
running. Keep the API key in your local shell or secret store and do not commit it.

When IT provides the VLM, set `MIDSCENE_MODEL_BASE_URL` to its OpenAI-compatible
API base URL (for example, ending in `/v1`), `MIDSCENE_MODEL_NAME` to the exact
served model ID, and `MIDSCENE_MODEL_FAMILY` to the Midscene adapter family
confirmed for that model. Set `MIDSCENE_MODEL_API_KEY` only if required. The
existing defaults above remain in place until those values are supplied.
Before using the browser inspection, run `pnpm run midscene:check-model`. This
optional readiness check calls only the endpoint's `/models` route and does not
open Edge or navigate. It reports `MODEL_UNAVAILABLE` for missing or unreachable
configuration. Browser inspection reports `MODEL_IMAGE_INPUT_UNSUPPORTED` if
the endpoint/model cannot accept screenshots; a successful `/models` response
does not by itself prove image capability.

With Edge already running on port 9223, the read-only script can be started with `pnpm run midscene:inspect-slots`. It requires the signed-in test session to be available in that Edge profile. The first trial should inspect only; stake controls and live gameplay remain unsupported until separately verified. The script uses no cache initially because Midscene does not cache query results, and canvas element localization cannot use its DOM/XPath cache.

## Safety

- The known casino route is the exact Games in Olympus route. Its stake-setting controls and limits have not been verified, so no stake adjustment is supported. The existing R0.20 flow remains available for 1–100 spins only when the remembered stake is already R0.20 and ante is off.
- A human must confirm each wagering plan. Spins are disabled by default and enabled only on the confirmed server path.
- Sports requests carry one selection for a single bet or multiple selections for one accumulator, with one exact total stake in integer cents. Verified stake rules are R1.00 minimum, one-cent increments, and R50 maximum; accumulator requests are capped at 10 selections. The agent prepares and verifies the requested betslip for review; only a distinct explicit chat authorization can reach a submission boundary.
- A successful login using the terminal-configured E2E username/password creates the designated test-account session. No separate client ID or funding-mode check is required. A generic greeting is not treated as proof of identity, and successful login alone never authorizes submission. Keep credentials out of source code, chat output, and logs.
- Preparation review snapshots and payout verification are implemented. No browser-based sports preparation or live submission test has been run. A final click requires the user's explicit chat Submit action.
- The remembered bet and ante state are checked before play; the runner does not change the bet. Missing ante data is treated as unverifiable and blocks the spin.
- A network guard checks every `doSpin` request and aborts requests outside the spin window, at an unapproved stake, or with missing/mismatched stake or ante fields.
- The response stake is checked for every spin. Balance progression is checked after every spin when the starting balance is available; a mismatch stops the run.
- Do not infer funding type from a Real/Simulate label or greeting. This PoC assumes the isolated browser is configured for the dedicated test account; no greeting or funding-type check is required.

## Folder map

- `src/agent/` — planner, validation, and execution
- `tests/setup/` — test account sign-in and session setup
- `tests/diagnostics/` — browser and game diagnostics
- `tests/agent/` — unit tests
- `tests/agent-sports.e2e.ts` — sports betslip preparation and manual review; submission disabled
- `tests/agent-sports-verify.e2e.ts` — My Bets verification blocked until unique run evidence exists
- `tests/chat/review-state.test.ts` — preparation review state and lifecycle unit tests
- `scripts/plan.ts` — plan-only command
- `chat/` — local confirmation UI and server
- `archive/` — old experiments; never run
