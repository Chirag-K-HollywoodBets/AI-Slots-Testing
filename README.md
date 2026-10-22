# AI Slots Testing PoC

## What this is

An AI-driven E2E test proof of concept. A chat request becomes a validated plan; a human confirms it; then Edge plays the requested number of Games in Olympus spins at R0.20 on a test account. The runner checks the remembered stake, each spin's reported stake, and balance progression after every spin when the starting balance is reported.

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
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList '--remote-debugging-port=9223', "--user-data-dir=$env:TEMP\edge-e2e-clean", '--no-first-run'
Start-Sleep 3; Invoke-RestMethod http://127.0.0.1:9223/json/version
```

Set the test account credentials in the same terminal used to start the chat server:

```powershell
$env:E2E_USER_HB_TEST_USERNAME = "<test-account-username>"
$env:E2E_USER_HB_TEST_PASSWORD = "<test-account-password>"
$env:E2E_TELEMETRY_DISABLED = "1" # optional
```

## Run

```powershell
node chat/server.cjs
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001), send `Log in, open Games in Olympus and play 10 spins at R0.20`, review the plan, then select **Confirm and run**.

## Safety

- Only Games in Olympus, 1–10 spins, and R0.20 per spin are allowed.
- A human must confirm each wagering plan. Spins are disabled by default and enabled only on the confirmed server path.
- The remembered bet and ante state are checked before play; the runner does not change the bet.
- A network guard checks every `doSpin` request and aborts requests outside the spin window or at an unapproved stake.
- The response stake is checked for every spin. Balance progression is checked after every spin when the starting balance is available; a mismatch stops the run.
- Use test credit only. Never run against an account using real funds.

## Folder map

- `src/agent/` — planner, validation, and execution
- `tests/setup/` — test account sign-in and session setup
- `tests/diagnostics/` — browser and game diagnostics
- `tests/agent/` — unit tests
- `scripts/plan.ts` — plan-only command
- `chat/` — local confirmation UI and server
- `archive/` — old experiments; never run
