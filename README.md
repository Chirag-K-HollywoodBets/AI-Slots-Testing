# AI Sports and Slots Testing PoC

## What this is

An AI-driven E2E test proof of concept. A chat request becomes a validated plan and a human confirms it before authenticated browser actions. The known slot route is Games in Olympus. Its existing R0.20 path checks the remembered stake, each spin's reported stake, and balance progression, but it cannot adjust the stake because those controls and limits have not been verified. Other game titles and stake amounts are blocked until their routes, identities, limits, and stake controls are verified. Sports stake rules are configured as R1.00 minimum, one-cent increments, and R50 maximum; the app caps accumulators at 10 requested selections. User-provided screenshots document two-leg multiple display, same-match replacement, Clear All behavior, and bonus/payout fields. Supplied terms define soccer-multiple bonus tiers, odds qualification thresholds, and payout caps. The sports path prepares a verified slip for review; the user performs any final submission manually.

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

A ready slip requires an exact readable stake and a valid displayed payout. Review labels the odds basis, displayed payout/stake multiplier, and adjustment from the base payout separately. Bonus eligibility remains explicitly unverified; the payout adjustment is not treated as proof of a bonus. The sportsbook's displayed payout and the winnings-cap estimate are shown separately.

```powershell
node chat/server.cjs
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001), send `Log in, open Games in Olympus and play 10 spins at R0.20`, review the canonical game, spin count, stake per spin, and maximum total stake, then select **Confirm and run**. The game must already remember R0.20 with ante off; unsupported remembered stakes stop before the first spin.

Sports prompts must specify one exact total stake and every requested team. Amounts from R1.00 through R50.00 in one-cent increments pass stake validation. The app caps accumulators at 10 selections. The supplied rules define soccer-multiple bonus tiers, the minimum count of legs with displayed odds >=0.2 required for each win-limit tier, and maximum winnings caps. For a single, the owner-confirmed payout rule is displayed odds multiplied by stake: 0.65 x R10 = R6.50 payout. The agent preserves that amount without adding the stake or labelling it profit. Single-slip profit remains unavailable. An inconsistent single payout blocks readiness. The existing accumulator calculation is handled separately. The agent prepares the requested slip for review and never submits a sports bet. The terminal-configured login credentials select the test account; no client ID or funding-mode check is required.

Example prompts:

- Preparation only: `Prepare an R10 accumulator on Arsenal to beat Chelsea and Liverpool to beat Everton. Do not submit.`
- Single selection: `Prepare a single R10 Premier League match-winner bet on Arsenal to beat Chelsea. Do not submit.`

The preparation-only prompt starts the review flow after explicit confirmation. Submission remains a manual user action.

## Manual safety check

1. Start the chat server with the designated test-account username and password configured in the local shell; never place credentials in a prompt.
2. Send either example above with an exact stake. Confirm missing, below-R1, and over-R50 stakes are rejected before a browser run. After confirming a valid preparation request, the app starts the review run.
3. Confirm R1.00, R1.01, and R50.00 pass stake validation. Browser preparation verifies exact selections, bet type, stake, and displayed payout.
4. Review the prepared betslip in the browser. If you decide to proceed, click Submit yourself.

The review timeout defaults to five minutes. Set `SPORTS_REVIEW_TIMEOUT_MS` before starting the chat server to change it; values are bounded to 30 seconds through 10 minutes.

The chat shows per-request input, output, and total token usage when the configured model provider returns usage metadata. These are provider-reported counts for the planning request (not browser execution); providers that omit usage metadata show no token count. The model name is included when counts are available.

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

With Edge already running on port 9223, the read-only script can be started with `pnpm run midscene:inspect-slots`. It requires the signed-in test session to be available in that Edge profile. The first trial should inspect only; stake controls and live gameplay remain unsupported until separately verified. The script uses no cache initially because Midscene does not cache query results, and canvas element localization cannot use its DOM/XPath cache.

## Safety

- The known casino route is the exact Games in Olympus route. Its stake-setting controls and limits have not been verified, so no stake adjustment is supported. The existing R0.20 flow remains available for 1–100 spins only when the remembered stake is already R0.20 and ante is off.
- A human must confirm each wagering plan. Spins are disabled by default and enabled only on the confirmed server path.
- Sports requests carry one selection for a single bet or multiple selections for one accumulator, with one exact total stake in integer cents. Verified stake rules are R1.00 minimum, one-cent increments, and R50 maximum; accumulator requests are capped at 10 selections. The agent prepares and verifies the requested betslip for review; it never submits a sports bet.
- A successful login using the terminal-configured E2E username/password creates the designated test-account session. No separate client ID or funding-mode check is required. A generic greeting is not treated as proof of identity, and successful login alone never authorizes submission. Keep credentials out of source code, chat output, and logs.
- Preparation review snapshots and payout verification are implemented. No browser-based sports preparation or live submission test has been run. The final Submit click remains with the user.
- The remembered bet and ante state are checked before play; the runner does not change the bet. Missing ante data is treated as unverifiable and blocks the spin.
- A network guard checks every `doSpin` request and aborts requests outside the spin window, at an unapproved stake, or with missing/mismatched stake or ante fields.
- The response stake is checked for every spin. Balance progression is checked after every spin when the starting balance is available; a mismatch stops the run.
- Do not infer funding type from a Real/Simulate label or greeting. The agent does not submit sports bets; final submission stays with the user.

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
