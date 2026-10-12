import { spawnSync } from 'node:child_process';

export interface HistoryTrace {
  traceId: string;
  name: string;
  status: string;
  latencyMs: number;
  cost: number;
  errorMessage: string;
  url: string;
}

export interface AgentHistory {
  available: boolean;
  reason: string;
  traces: HistoryTrace[];
  summary: string;
}

const HOST = process.env.NEATLOGS_HOST ?? 'https://app.neatlogs.com';
const PROJECT = process.env.NEATLOGS_PROJECT_ID ?? '';

function runCli(args: string[]): { ok: boolean; stdout: string; reason: string } {
  if (!process.env.NEATLOGS_TOKEN) {
    return { ok: false, stdout: '', reason: 'NEATLOGS_TOKEN not set (needs a service-account token; SDK key cannot read).' };
  }
  if (!PROJECT) return { ok: false, stdout: '', reason: 'NEATLOGS_PROJECT_ID not set.' };
  try {
    const env = { ...process.env };
    delete env.NEATLOGS_API_KEY; // credential isolation: token-based readback only
    const r = spawnSync('neatlogs', ['--host', HOST, '--project', PROJECT, ...args, '--json'], {
      env, encoding: 'utf8', timeout: 30000,
    });
    if (r.error) return { ok: false, stdout: '', reason: `CLI unavailable (${(r.error as Error).message}; npm i -g neatlogs-cli, Node 22/24).` };
    if (r.status !== 0) return { ok: false, stdout: '', reason: `CLI exit ${r.status}: ${(r.stderr || '').slice(0, 300)}` };
    return { ok: true, stdout: r.stdout, reason: '' };
  } catch (e) {
    return { ok: false, stdout: '', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The agent reading its own history: recent actionsforge-fix traces with
 * status/cost/error, so the next run avoids repeating failed strategies.
 * Read-only, bounded, and honest about unavailability (OAuth/service token
 * is a human-gated prerequisite — SDK ingest keys cannot read).
 */
export async function readAgentHistory(limit = 8): Promise<AgentHistory> {
  const none = (reason: string): AgentHistory => ({ available: false, reason, traces: [], summary: `No Neatlogs history: ${reason}` });
  const list = runCli(['traces', 'list', '--limit', String(limit)]);
  if (!list.ok) return none(list.reason);
  let items: any[] = [];
  try {
    const parsed = JSON.parse(list.stdout || '{}');
    items = Array.isArray(parsed) ? parsed : parsed.traces ?? parsed.items ?? [];
  } catch {
    return none('unparseable CLI output');
  }
  const traces: HistoryTrace[] = items.slice(0, limit).map((t: any) => ({
    traceId: String(t.trace_id ?? t.id ?? ''),
    name: String(t.name ?? t.workflow ?? ''),
    status: String(t.status ?? ''),
    latencyMs: Number(t.latency_ms ?? 0),
    cost: Number(t.cost ?? t.total_cost ?? 0),
    errorMessage: String(t.error_message ?? t.error ?? ''),
    url: String(t.url ?? ''),
  }));
  const relevant = traces.filter((t) => /actionsforge/i.test(t.name));
  const errs = relevant.filter((t) => /error|fail/i.test(t.status));
  const parts = [
    `${relevant.length} prior actionsforge-fix run(s) visible`,
    errs.length ? `${errs.length} ended error/fail${errs[0]?.errorMessage ? ` (latest: ${errs[0].errorMessage.slice(0, 200)})` : ''}` : 'none recorded as failed',
  ];
  const cost = relevant.filter((t) => t.cost > 0);
  if (cost.length) parts.push(`avg cost $${(cost.reduce((s, t) => s + t.cost, 0) / cost.length).toFixed(4)} over ${cost.length} runs`);
  return { available: true, reason: '', traces: relevant, summary: parts.join('; ') };
}
