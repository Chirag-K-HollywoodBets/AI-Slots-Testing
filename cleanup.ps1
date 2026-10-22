# Tidies hollywoodbets-e2e-poc. Moves old experiments into archive\ — deletes only
# the stray empty "-Recurse" file and generated run output.
# Preview first:   .\cleanup.ps1 -WhatIf
# Then run:        .\cleanup.ps1
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

foreach ($d in 'archive\edge-scripts', 'archive\tests', 'archive\fixtures', 'archive\configs', 'archive\chat', 'tests\diagnostics') {
  New-Item -ItemType Directory -Force -Path $d -WhatIf:$false | Out-Null
}

function Move-IfExists($from, $to) {
  if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination $to -Force }
  else { Write-Host "skip (not found): $from" -ForegroundColor DarkGray }
}

# Stray empty file created by a mistyped PowerShell command.
if (Test-Path -LiteralPath '.\-Recurse') { Remove-Item -LiteralPath '.\-Recurse' }

# One-off playwright-core scripts from the Edge investigation.
Get-ChildItem -File -Filter 'edge-*.cjs' | ForEach-Object { Move-IfExists $_.FullName "archive\edge-scripts\$($_.Name)" }

# Superseded by scripts\plan.ts.
Move-IfExists 'test-planner-cli.ts' 'archive\test-planner-cli.ts'

# Configs nothing uses any more (chat uses e2e.edge-clean.config.ts).
Move-IfExists 'e2e.edge.config.ts'       'archive\configs\e2e.edge.config.ts'
Move-IfExists 'e2e.ai-fixture.config.ts' 'archive\configs\e2e.ai-fixture.config.ts'

# Chat leftovers: a backup and a copy of the page script that is already inline in server.cjs.
Move-IfExists 'chat\server.cjs.bak'     'archive\chat\server.cjs.bak'
Move-IfExists 'chat\debug-frontend.js'  'archive\chat\debug-frontend.js'

# Read-only checks you still want, grouped together.
foreach ($f in 'edge-cdp.e2e.ts', 'edge-live-events.e2e.ts', 'homepage.smoke.e2e.ts', 'inspect-live-sports.e2e.ts', 'olympus-game-test.e2e.ts') {
  Move-IfExists "tests\$f" "tests\diagnostics\$f"
}

# Early experiments against local mock pages.
foreach ($f in 'example.e2e.ts', 'premier-league-navigation.e2e.ts', 'ai-live-soccer-observation.e2e.ts',
                'soccer-betslip.e2e.ts', 'soccer-navigation.e2e.ts', 'ai-fixture.e2e.ts', 'ai-sports-fixture.e2e.ts',
                'ai-football-event-fixture.e2e.ts', 'ai-football-event-negative.e2e.ts', 'fixture-server.mjs') {
  Move-IfExists "tests\$f" "archive\tests\$f"
}
Get-ChildItem fixtures -File -ErrorAction SilentlyContinue | ForEach-Object { Move-IfExists $_.FullName "archive\fixtures\$($_.Name)" }
if ((Test-Path fixtures) -and -not (Get-ChildItem fixtures)) { Remove-Item fixtures }

# Generated run output (recreated every run, already in .gitignore).
foreach ($f in '.e2e\report.json', '.e2e\ai-trace.json') { if (Test-Path $f) { Remove-Item $f } }

Write-Host "`nDone. E2E tests now:" -ForegroundColor Green
Get-ChildItem tests -Recurse -Filter *.e2e.ts | ForEach-Object { $_.FullName.Replace("$PSScriptRoot\", '') }
