# Slot flow test use cases

These cases cover the current implementation without placing live spins. Use unit or mocked adapter tests unless a case is explicitly approved for a test account. Never run against real funds.

## Current catalogue limitation

The known route is **Games in Olympus** at `/lobby/top-games/#/g/games-in-olympus`. Its stake controls and broader stake limits are not verified. The existing flow supports only the remembered **R0.20** stake with ante off; it does not change the stake. Other game titles and stake amounts must be rejected before the game opens.

## Use cases

| ID | Scenario | Input / setup | Expected result |
|---|---|---|---|
| SLOT-01 | Resolve the catalogued title | Request Games in Olympus | Resolve to `games-in-olympus`; use only its allowlisted route. |
| SLOT-02 | Reject an unknown title | Request a different slot game | Block before opening a game and report the known route and its stake-control limitation. |
| SLOT-03 | Reject a lookalike title | Request “Gates of Olympus” | Do not map it to Games in Olympus; block before navigation. |
| SLOT-04 | Require the title for a slot request | Request spins without naming a game | Block rather than selecting a default game. |
| SLOT-05 | Require spin count and stake | Omit either value | Block and ask for the missing value; do not apply defaults. |
| SLOT-06 | Accept the legacy stake | Games in Olympus, 1 spin, R0.20 | Plan only if the remembered stake is R0.20, ante is off, and normal confirmation/test-account safeguards are satisfied. |
| SLOT-07 | Reject a non-verified amount | Request R0.21, R0.10, or R0.201 | Reject before opening the game; do not round, cap, or substitute. |
| SLOT-08 | Reject a missing or invalid stake | Missing stake, zero, negative, or malformed amount | Reject before browser interaction. |
| SLOT-09 | Confirm the plan summary | Games in Olympus, 10 spins, R0.20 | Confirmation names Games in Olympus, 10 spins, R0.20 per spin, and maximum total stake R2.00. No game interaction occurs before confirmation. |
| SLOT-10 | Verify max legacy exposure | Games in Olympus, 100 spins, R0.20 | Confirmation shows maximum total stake R20.00 using integer cents. |
| SLOT-11 | Reject excess spin count | Games in Olympus, 101 spins | Reject before opening the game. |
| SLOT-12 | Require open-before-play order | Plan contains `play_slot` without a preceding matching `open_game` | Plan validation fails and no adapter method runs. |
| SLOT-13 | Reject a different open game | Open one catalogued ID, then request play for another ID | Plan validation fails; no route is inferred or constructed from model text. |
| SLOT-14 | Refuse a remembered-stake mismatch | `doInit` reports a stake other than R0.20 | Stop before any spin; report zero completed and zero attempted spins. Do not click stake controls or send a test spin. |
| SLOT-15 | Refuse ante enabled | `doInit` reports ante on | Stop before any spin and report zero completed spins. |
| SLOT-16 | Refuse unverifiable ante state | `doInit` omits the ante field | Treat state as unknown and stop before any spin. |
| SLOT-17 | Block spin traffic during setup | Game emits `doSpin` before the authorized spin window | Network guard aborts the request; no spin is authorized. |
| SLOT-18 | Allow the exact authorized request | Armed request has the confirmed coin value and line count totaling R0.20, with explicit `bl=0` | Guard permits the request. |
| SLOT-19 | Block request outside the spin window | Exact R0.20 request while guard is unarmed | Guard aborts the request. |
| SLOT-20 | Block stake mismatch or missing fields | Request differs from R0.20 or omits `c`, `l`, or `bl` | Guard aborts the request before it leaves the browser. |
| SLOT-21 | Stop on provider stake mismatch | Provider response reports a stake other than R0.20 or ante on | Stop immediately; do not start another spin; report verified completed and attempted counts. |
| SLOT-22 | Stop after the first unsuccessful verification | First spin response has no verifiable stake/balance or balance progression mismatches | Stop before the next spin and report progress accurately. |
| SLOT-23 | Cancel at confirmation | User selects Cancel | No game opens and no spin request is sent. |
| SLOT-24 | Require test safeguards | Spins are disabled or the confirmed test-account path is unavailable | Stop before spinning; do not switch account mode or bypass safeguards. |

## Coverage mapping

- Catalogue resolution: `tests/agent/schema.test.ts`
- Plan order, exact stake rejection, and progress reporting: `tests/agent/executor.test.ts`
- Network stake, ante, and spin-window rules: `validateSpinRequest` cases in `tests/agent/schema.test.ts`
- Confirmation total: `tests/chat/slot-summary.test.ts`

Cases involving real provider controls, account mode, or live network behavior require a separately approved test-account validation. The stake adjustment control is currently unverified, so no use case should assert that the runner can change a stake.
