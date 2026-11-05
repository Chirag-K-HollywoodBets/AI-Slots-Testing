import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type MetricNumber = number | null;

interface LlmCall {
  timestamp: string;
  run: string;
  phase: string;
  model: string;
  promptTokens: MetricNumber;
  completionTokens: MetricNumber;
  totalTokens: MetricNumber;
  latencyMs: MetricNumber;
  outcome: string;
}

interface ScanCounts {
  htmlFiles: number;
  htmlCalls: number;
  slotReports: number;
  slotLogs: number;
  traceFiles: number;
  tokenUsageLines: number;
  structuredUsageRecords: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, 'reports', 'metrics');
const csvPath = path.join(outputDir, 'llm-calls.csv');
const summaryPath = path.join(outputDir, 'summary.md');
const textExtensions = new Set(['.log', '.md', '.txt', '.json', '.jsonl', '.out']);
const calls: LlmCall[] = [];
const scannedTextFiles = new Set<string>();
const counts: ScanCounts = {
  htmlFiles: 0,
  htmlCalls: 0,
  slotReports: 0,
  slotLogs: 0,
  traceFiles: 0,
  tokenUsageLines: 0,
  structuredUsageRecords: 0,
};

function recordNumber(value: unknown): MetricNumber {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function firstNumber(records: unknown[], keys: string[]): MetricNumber {
  for (const value of records) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const parsed = recordNumber(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function firstString(records: unknown[], keys: string[]): string | null {
  for (const value of records) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

function toTimestamp(value: unknown): string {
  let date: Date | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) date = new Date(parsed);
  }
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : 'not recorded';
}

function asOutcome(value: unknown): string {
  if (value === undefined || value === null) return 'not recorded';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asErrorOutcome(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : 'Error';
    const message = typeof record.message === 'string' ? record.message : null;
    if (message) return `${name}: ${message}`;
  }
  return asOutcome(value);
}

function phaseForTask(task: Record<string, unknown>): string {
  const subtype = typeof task.subType === 'string' ? task.subType : null;
  const type = typeof task.type === 'string' ? task.type : null;
  if (subtype && type) return `${subtype} (${type})`;
  return subtype ?? type ?? 'not recorded';
}

function addHtmlCall(run: string, execution: Record<string, unknown>, task: Record<string, unknown>): void {
  const usage = task.usage;
  const timing = task.timing;
  const records = [usage, timing, task];
  const output = task.output ?? task.answer ?? task.result ?? task.response;
  const status = typeof task.status === 'string' ? task.status : null;
  const error = task.error;
  const outcomeParts = [
    status ? `status=${status}` : null,
    output !== undefined ? `answer=${asOutcome(output)}` : null,
    error !== undefined ? `error=${asErrorOutcome(error)}` : null,
  ].filter((part): part is string => part !== null);

  calls.push({
    timestamp: toTimestamp(firstNumber([timing, execution], ['start', 'logTime']) ?? firstString([task], ['timestamp'])),
    run,
    phase: phaseForTask(task),
    model: firstString(records, ['model_name', 'response_model_name', 'model']) ?? 'not recorded',
    promptTokens: firstNumber([usage], ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']),
    completionTokens: firstNumber([usage], ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']),
    totalTokens: firstNumber([usage], ['total_tokens', 'totalTokens']),
    latencyMs: firstNumber([usage], ['time_cost', 'total_time_cost', 'duration_ms', 'latency_ms'])
      ?? firstNumber([timing], ['cost', 'durationMs', 'duration_ms'])
      ?? (() => {
        const start = firstNumber([timing], ['start']);
        const end = firstNumber([timing], ['end']);
        return start !== null && end !== null && end >= start ? end - start : null;
      })(),
    outcome: outcomeParts.join('; ') || 'not recorded',
  });
}

function parseMidsceneDump(html: string): Record<string, unknown> | null {
  const marker = '<script type="midscene_web_dump" data-group-id="';
  const start = html.lastIndexOf(marker);
  if (start < 0) return null;
  const contentStart = html.indexOf('>', start);
  const end = html.indexOf('</script>', contentStart + 1);
  if (contentStart < 0 || end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(html.slice(contentStart + 1, end));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isMidsceneAiTask(task: Record<string, unknown>): boolean {
  return task.type === 'Insight' || task.type === 'Planning' || (task.usage !== undefined && task.usage !== null);
}

async function scanMidsceneReports(): Promise<void> {
  const directory = path.join(root, 'midscene_run', 'report');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.html') continue;
    counts.htmlFiles++;
    const filePath = path.join(directory, entry.name);
    const html = await readFile(filePath, 'utf8');
    const dump = parseMidsceneDump(html);
    if (!dump || !Array.isArray(dump.executions)) continue;
    const run = path.basename(entry.name, '.html');
    for (const executionValue of dump.executions) {
      if (!executionValue || typeof executionValue !== 'object') continue;
      const execution = executionValue as Record<string, unknown>;
      if (!Array.isArray(execution.tasks)) continue;
      for (const taskValue of execution.tasks) {
        if (!taskValue || typeof taskValue !== 'object') continue;
        const task = taskValue as Record<string, unknown>;
        if (!isMidsceneAiTask(task)) continue;
        addHtmlCall(run, execution, task);
        counts.htmlCalls++;
      }
    }
  }
}

function metricFromObject(record: Record<string, unknown>, run: string, timestampFallback: unknown): LlmCall | null {
  const usageValue = record.usage ?? record.tokenUsage ?? record.token_usage ?? record;
  if (!usageValue || typeof usageValue !== 'object') return null;
  const usage = usageValue as Record<string, unknown>;
  const prompt = firstNumber([usage], ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
  const completion = firstNumber([usage], ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']);
  const total = firstNumber([usage], ['total_tokens', 'totalTokens']);
  if (prompt === null && completion === null && total === null) return null;

  const phase = firstString([record], ['phase', 'taskType', 'task_type', 'callType', 'operation', 'subType', 'type'])
    ?? 'not recorded';
  const answer = record.answer ?? record.result ?? record.output ?? record.response;
  const status = firstString([record], ['status', 'outcome']);
  const records = [usage, record];
  return {
    timestamp: toTimestamp(firstString([record], ['timestamp', 'startedAt', 'startTime'])
      ?? firstNumber([record], ['timestamp', 'startedAt', 'startTime'])
      ?? timestampFallback),
    run,
    phase,
    model: firstString(records, ['model_name', 'response_model_name', 'model']) ?? 'not recorded',
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    latencyMs: firstNumber([usage, record], ['time_cost', 'total_time_cost', 'latencyMs', 'latency_ms', 'durationMs', 'duration_ms']),
    outcome: [status ? `status=${status}` : null, answer !== undefined ? `answer=${asOutcome(answer)}` : null]
      .filter((part): part is string => part !== null).join('; ') || 'not recorded',
  };
}

function collectStructuredMetrics(value: unknown, run: string, timestampFallback: unknown, seen: Set<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectStructuredMetrics(child, run, timestampFallback, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  const hasCallContext = ['phase', 'taskType', 'task_type', 'callType', 'operation', 'subType', 'type']
    .some((key) => typeof record[key] === 'string');
  if (hasCallContext) {
    const metric = metricFromObject(record, run, timestampFallback);
    if (metric) {
      calls.push(metric);
      counts.structuredUsageRecords++;
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'usage' || key === 'tokenUsage' || key === 'token_usage') continue;
    collectStructuredMetrics(child, run, timestampFallback, seen);
  }
}

function extractTextField(text: string, labels: string[]): MetricNumber {
  const alternatives = labels.join('|');
  const pattern = new RegExp(`\\b(?:${alternatives})(?:[_\\s-]?tokens?)?["']?\\s*[:=]\\s*["']?([0-9][0-9,]*(?:\\.[0-9]+)?)`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  return recordNumber(match[1].replace(/,/g, ''));
}

function extractTextString(text: string, labels: string[]): string | null {
  const pattern = new RegExp(`\\b(?:${labels.join('|')})\\s*[:=]\\s*["']?([^,;|\\s"']+)`, 'i');
  return text.match(pattern)?.[1] ?? null;
}

function extractTextTimestamp(text: string): string {
  const value = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/)?.[0];
  return value ? toTimestamp(value) : 'not recorded';
}

function addTokenUsageLine(line: string, run: string): void {
  calls.push({
    timestamp: extractTextTimestamp(line),
    run,
    phase: extractTextString(line, ['phase', 'task_type', 'task', 'type']) ?? 'not recorded',
    model: extractTextString(line, ['model']) ?? 'not recorded',
    promptTokens: extractTextField(line, ['prompt', 'input']),
    completionTokens: extractTextField(line, ['completion', 'output']),
    totalTokens: extractTextField(line, ['total']),
    latencyMs: extractTextField(line, ['latency_ms', 'duration_ms']),
    outcome: line.trim() || 'not recorded',
  });
  counts.tokenUsageLines++;
}

function runNameForFile(filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const parts = relative.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : path.basename(filePath);
}

async function scanTextFile(filePath: string, run = runNameForFile(filePath)): Promise<void> {
  const normalized = path.resolve(filePath);
  if (scannedTextFiles.has(normalized)) return;
  scannedTextFiles.add(normalized);
  const text = await readFile(normalized, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/token\s+usage/i.test(line)) addTokenUsageLine(line, run);
  }
}

async function walkTextFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkTextFiles(fullPath));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

async function scanSlotsAndTraces(): Promise<void> {
  const slotsRoot = path.join(root, 'reports', 'slots');
  let runDirectories: Dirent[];
  try {
    runDirectories = await readdir(slotsRoot, { withFileTypes: true });
  } catch {
    runDirectories = [];
  }

  for (const runDirectory of runDirectories) {
    if (!runDirectory.isDirectory()) continue;
    const runPath = path.join(slotsRoot, runDirectory.name);
    const reportPath = path.join(runPath, 'report.json');
    const logPath = path.join(runPath, 'run.log');
    try {
      const reportText = await readFile(reportPath, 'utf8');
      counts.slotReports++;
      scannedTextFiles.add(path.resolve(reportPath));
      try {
        const reportValue: unknown = JSON.parse(reportText);
        const reportRecord = reportValue && typeof reportValue === 'object' ? reportValue as Record<string, unknown> : {};
        collectStructuredMetrics(reportValue, runDirectory.name, reportRecord.startedAt ?? reportRecord.completedAt, new Set());
      } catch {
        // Token usage text in malformed/partial reports is still scanned below.
      }
      for (const line of reportText.split(/\r?\n/)) {
        if (/token\s+usage/i.test(line)) addTokenUsageLine(line, runDirectory.name);
      }
    } catch {
      // Reports are optional for partially captured runs.
    }
    try {
      await scanTextFile(logPath, runDirectory.name);
      counts.slotLogs++;
    } catch {
      // Logs are optional for partially captured runs.
    }
  }

  const traceRoots = ['.e2e', 'test-results', 'playwright-report', 'e2e-results', 'e2e-output'];
  for (const traceRoot of traceRoots) {
    const directory = path.join(root, traceRoot);
    for (const filePath of await walkTextFiles(directory)) {
      if (path.resolve(filePath).startsWith(path.resolve(outputDir) + path.sep)) continue;
      try {
        await scanTextFile(filePath);
        counts.traceFiles++;
      } catch {
        // Keep collecting from the other outputs if one file is unreadable.
      }
    }
  }
}

async function scanPlannerCalls(): Promise<void> {
  const filePath = path.join(outputDir, 'planner-calls.jsonl');
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const numeric = (value: unknown): MetricNumber => value === 'not recorded' ? null : recordNumber(value);
      calls.push({
        timestamp: toTimestamp(record.timestamp),
        run: 'chat-server',
        phase: 'planner',
        model: typeof record.model === 'string' && record.model.trim() ? record.model : 'not recorded',
        promptTokens: numeric(record.promptTokens),
        completionTokens: numeric(record.completionTokens),
        totalTokens: numeric(record.totalTokens),
        latencyMs: numeric(record.latencyMs),
        outcome: typeof record.outcome === 'string' ? record.outcome : 'not recorded',
      });
    } catch {
      // Ignore a partial final line or malformed record and keep scanning.
    }
  }
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function csvMetric(value: MetricNumber): string {
  return value === null ? 'not recorded' : String(value);
}

function formatNumber(value: number | null): string {
  return value === null ? 'not recorded' : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function compactOutcome(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 297)}...` : singleLine;
}

function sum(values: MetricNumber[]): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  return recorded.length ? recorded.reduce((total, value) => total + value, 0) : null;
}

function average(values: MetricNumber[]): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  return recorded.length ? recorded.reduce((total, value) => total + value, 0) / recorded.length : null;
}

function markdownTable(rows: string[][]): string {
  if (!rows.length) return '_No recorded calls._';
  const [header, ...body] = rows;
  const separator = header.map(() => '---');
  return [header, separator, ...body].map((row) => `| ${row.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`).join('\n');
}

function groupedRows(keyFor: (call: LlmCall) => string): Map<string, LlmCall[]> {
  const groups = new Map<string, LlmCall[]>();
  for (const call of calls) {
    const key = keyFor(call) || 'not recorded';
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  return groups;
}

function groupTable(groups: Map<string, LlmCall[]>): string {
  const rows = [['Group', 'Calls', 'Prompt tokens sum / avg', 'Completion tokens sum / avg', 'Total tokens sum / avg', 'Latency average ms']];
  for (const [name, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const promptSum = sum(group.map((call) => call.promptTokens));
    const completionSum = sum(group.map((call) => call.completionTokens));
    const totalSum = sum(group.map((call) => call.totalTokens));
    rows.push([
      name,
      String(group.length),
      `${formatNumber(promptSum)} / ${formatNumber(average(group.map((call) => call.promptTokens)))}`,
      `${formatNumber(completionSum)} / ${formatNumber(average(group.map((call) => call.completionTokens)))}`,
      `${formatNumber(totalSum)} / ${formatNumber(average(group.map((call) => call.totalTokens)))}`,
      formatNumber(average(group.map((call) => call.latencyMs))),
    ]);
  }
  return markdownTable(rows);
}

function buildSummary(): string {
  const promptValues = calls.map((call) => call.promptTokens);
  const completionValues = calls.map((call) => call.completionTokens);
  const totalValues = calls.map((call) => call.totalTokens);
  const latencyValues = calls.map((call) => call.latencyMs);
  const completeRunTotals: number[] = [];
  for (const group of groupedRows((call) => call.run).values()) {
    if (group.every((call) => call.totalTokens !== null)) {
      const total = group.reduce((accumulator, call) => accumulator + (call.totalTokens ?? 0), 0);
      completeRunTotals.push(total);
    }
  }

  const tokenlessTypes = [...groupedRows((call) => call.phase).entries()]
    .map(([phase, group]) => ({ phase, count: group.filter((call) => call.promptTokens === null && call.completionTokens === null && call.totalTokens === null).length }))
    .filter((item) => item.count > 0);
  const partiallyRecordedTypes = [...groupedRows((call) => call.phase).entries()]
    .filter(([, group]) => group.some((call) => call.promptTokens !== null || call.completionTokens !== null || call.totalTokens !== null)
      && group.some((call) => call.promptTokens === null || call.completionTokens === null || call.totalTokens === null));

  const slowest = calls.filter((call) => call.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .slice(0, 10)
    .map((call) => [call.timestamp, call.run, call.phase, call.model, formatNumber(call.latencyMs), compactOutcome(call.outcome)]);
  const slowestTable = markdownTable([['Timestamp', 'Run', 'Phase/task type', 'Model', 'Latency ms', 'Outcome'], ...slowest]);
  const plannerCalls = calls.filter((call) => call.run === 'chat-server' && call.phase === 'planner');
  const plannerOutcomes = new Map<string, number>();
  for (const call of plannerCalls) plannerOutcomes.set(call.outcome, (plannerOutcomes.get(call.outcome) ?? 0) + 1);
  const plannerOutcomeSummary = plannerOutcomes.size
    ? [...plannerOutcomes.entries()].map(([outcome, count]) => `${outcome}: ${count}`).join('; ')
    : 'not recorded';

  const tokenlessText = tokenlessTypes.length
    ? tokenlessTypes.map(({ phase, count }) => `- ${phase}: ${count} call(s) have no prompt/completion/total token fields recorded.`).join('\n')
    : '- None.';
  const partialText = partiallyRecordedTypes.length
    ? partiallyRecordedTypes.map(([phase, group]) => `- ${phase}: one or more calls have incomplete token fields.`).join('\n')
    : '- None.';

  return [
    '# LLM call metrics',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Sources scanned',
    '',
    `- Midscene HTML reports: ${counts.htmlFiles} file(s), ${counts.htmlCalls} AI task call(s).`,
    `- Slot reports: ${counts.slotReports} report.json file(s), ${counts.slotLogs} run.log file(s).`,
    `- E2E/trace text outputs: ${counts.traceFiles} file(s); token-usage text records: ${counts.tokenUsageLines}.`,
    `- Structured token-usage records outside Midscene HTML: ${counts.structuredUsageRecords}.`,
    `- Total extracted calls: ${calls.length}.`,
    `- Planner JSONL records: ${plannerCalls.length}.`,
    '',
    '## Totals and averages',
    '',
    `- Prompt tokens: recorded sum ${formatNumber(sum(promptValues))}; average of recorded values ${formatNumber(average(promptValues))}.`,
    `- Completion tokens: recorded sum ${formatNumber(sum(completionValues))}; average of recorded values ${formatNumber(average(completionValues))}.`,
    `- Total tokens: recorded sum ${formatNumber(sum(totalValues))}; average of recorded values ${formatNumber(average(totalValues))}.`,
    `- Latency: average of recorded values ${formatNumber(average(latencyValues))} ms.`,
    '- Sums and averages include only values explicitly present in the source records. Missing values are not inferred.',
    '',
    '## Per phase/task type',
    '',
    groupTable(groupedRows((call) => call.phase)),
    '',
    '## Per run',
    '',
    groupTable(groupedRows((call) => call.run)),
    '',
    '## Per model',
    '',
    groupTable(groupedRows((call) => call.model)),
    '',
    '## Planner calls',
    '',
    `- Calls: ${plannerCalls.length}; outcomes: ${plannerOutcomeSummary}.`,
    `- Prompt tokens: recorded sum ${formatNumber(sum(plannerCalls.map((call) => call.promptTokens)))}; average ${formatNumber(average(plannerCalls.map((call) => call.promptTokens)))}.`,
    `- Completion tokens: recorded sum ${formatNumber(sum(plannerCalls.map((call) => call.completionTokens)))}; average ${formatNumber(average(plannerCalls.map((call) => call.completionTokens)))}.`,
    `- Total tokens: recorded sum ${formatNumber(sum(plannerCalls.map((call) => call.totalTokens)))}; average ${formatNumber(average(plannerCalls.map((call) => call.totalTokens)))}.`,
    `- Latency: average of recorded values ${formatNumber(average(plannerCalls.map((call) => call.latencyMs)))} ms.`,
    '',
    '## Call types without token data',
    '',
    tokenlessText,
    '',
    'Call types with incomplete token fields:',
    '',
    partialText,
    '',
    '## Slowest calls',
    '',
    slowestTable,
    '',
    '## Token cost per typical run',
    '',
    '- Monetary cost: not recorded; no token pricing configuration was found or assumed.',
    `- Average total tokens per fully recorded run: ${formatNumber(average(completeRunTotals))} across ${completeRunTotals.length} fully recorded run(s). A run is included only when every extracted call for it has an explicit total-token value.`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  await scanMidsceneReports();
  await scanPlannerCalls();
  await scanSlotsAndTraces();
  await mkdir(outputDir, { recursive: true });

  const header = ['timestamp', 'run', 'phase/task type', 'model', 'prompt tokens', 'completion tokens', 'total', 'latency ms', 'outcome'];
  const csv = [header, ...calls.map((call) => [
    call.timestamp,
    call.run,
    call.phase,
    call.model,
    csvMetric(call.promptTokens),
    csvMetric(call.completionTokens),
    csvMetric(call.totalTokens),
    csvMetric(call.latencyMs),
    call.outcome,
  ])].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

  await writeFile(csvPath, csv, 'utf8');
  await writeFile(summaryPath, buildSummary(), 'utf8');
  console.log(`LLM metrics: ${calls.length} call(s) from ${counts.htmlFiles} Midscene report(s) and ${counts.traceFiles} trace/output file(s).`);
  console.log(`CSV: ${path.relative(root, csvPath)}`);
  console.log(`Summary: ${path.relative(root, summaryPath)}`);
}

await main();
