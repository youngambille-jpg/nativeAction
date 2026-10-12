import { span } from 'neatlogs';
import { Octokit } from '@octokit/rest';
import { config } from './config.js';

export function getOctokit(): Octokit {
  // Public repos work unauthenticated (rate-limited); token raises limits.
  return new Octokit(config.githubToken ? { auth: config.githubToken } : {});
}

export interface GhContext {
  owner: string;
  repo: string;
}

export interface RepoFacts {
  repo: string;
  defaultBranch: string;
  languages: string[];
  isReactNative: boolean;
  hasAndroid: boolean;
  hasIos: boolean;
  nodeEngines: string;
  packageManager: string;
  workflowFiles: string[];
  topLevel: string[];
  fileCount: number;
  note: string;
}

export function parseRepoUrl(url: string): GhContext {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error(`Cannot parse GitHub repo URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** TOOL spans: every GitHub call nests under the WORKFLOW root. */
export const inspectRepo = span(
  { kind: 'TOOL', toolName: 'github_inspect_repo' },
  async (repoUrl: string): Promise<RepoFacts> => {
    const ctx = parseRepoUrl(repoUrl);
    const octo = getOctokit();
    const { data: repo } = await octo.repos.get({ owner: ctx.owner, repo: ctx.repo });
    const branch = repo.default_branch ?? 'main';
    const { data: tree } = await octo.git.getTree({
      owner: ctx.owner,
      repo: ctx.repo,
      tree_sha: branch,
      recursive: 'true',
    });
    const paths = (tree.tree ?? []).map((t) => t.path ?? '').filter(Boolean);
    const has = (p: string) => paths.some((x) => x === p || x.startsWith(p + '/'));
    const text = async (path: string): Promise<string> => {
      try {
        const { data } = await octo.repos.getContent({ owner: ctx.owner, repo: ctx.repo, path, ref: branch });
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return '';
        return Buffer.from(data.content, 'base64').toString('utf8').slice(0, 4000);
      } catch {
        return '';
      }
    };

    const pkgRaw = await text('package.json');
    let nodeEngines = '';
    let packageManager = '';
    let isReactNative = false;
    try {
      const pkg = JSON.parse(pkgRaw || '{}') as {
        engines?: { node?: string };
        packageManager?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      nodeEngines = pkg.engines?.node ?? '';
      packageManager = pkg.packageManager ?? (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm');
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      isReactNative = 'react-native' in deps;
    } catch {
      // leave defaults
    }
    const workflowFiles = paths.filter((p) => p.startsWith('.github/workflows/')).slice(0, 20);

    const facts: RepoFacts = {
      repo: `${ctx.owner}/${ctx.repo}`,
      defaultBranch: branch,
      languages: [repo.language ?? 'unknown'],
      isReactNative,
      hasAndroid: has('android'),
      hasIos: has('ios'),
      nodeEngines,
      packageManager,
      workflowFiles,
      topLevel: [...new Set(paths.map((p) => p.split('/')[0]))].slice(0, 30),
      fileCount: paths.length,
      note:
        !isReactNative && !has('android')
          ? 'Not a React Native Android project: no react-native dependency and no android/ dir. Treat as generic Node/TS; do not promise an APK.'
          : '',
    };
    return facts;
  },
);

export const listTree = span(
  { kind: 'TOOL', toolName: 'github_list_tree' },
  async (repoUrl: string, branch: string, prefix: string, limit = 40): Promise<string[]> => {
    const ctx = parseRepoUrl(repoUrl);
    try {
      const { data: tree } = await getOctokit().git.getTree({ owner: ctx.owner, repo: ctx.repo, tree_sha: branch, recursive: 'true' });
      return (tree.tree ?? [])
        .map((t) => t.path ?? '')
        .filter((p) => p.startsWith(prefix))
        .slice(0, limit);
    } catch {
      return [];
    }
  },
);

export interface FileFinding {
  path: string;
  chars: number;
  summary: string;
}

export interface RepoAnalysis {
  filesRead: FileFinding[];
  findings: string[];
}

export const readRepoFile = span(
  { kind: 'TOOL', toolName: 'github_read_file' },
  async (repoUrl: string, path: string, branch: string, maxChars = 6000): Promise<string> => {
    const ctx = parseRepoUrl(repoUrl);
    try {
      const { data } = await getOctokit().repos.getContent({ owner: ctx.owner, repo: ctx.repo, path, ref: branch });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return '';
      return Buffer.from(data.content, 'base64').toString('utf8').slice(0, maxChars);
    } catch {
      return '';
    }
  },
);

/**
 * The analysis loop: opens each key file in turn (workflow YAMLs first,
 * then package.json / workspace / codemagic) and runs deterministic checks.
 * One TOOL span per file so the trace shows the loop iterating.
 */
export const analyzeRepo = span(
  { kind: 'TOOL', toolName: 'github_analyze_files' },
  async (repoUrl: string, facts: RepoFacts): Promise<RepoAnalysis> => {
    const findings: string[] = [];
    const filesRead: FileFinding[] = [];
    const read = async (path: string): Promise<string> => {
      const content = await readRepoFile(repoUrl, path, facts.defaultBranch);
      filesRead.push({
        path,
        chars: content.length,
        summary: content ? `read ${content.length} chars` : 'missing/unreadable',
      });
      return content;
    };

    // 1. Workflow files: loop through each, checking the known RN-Android
    // failure modes from the playbook (PLAN.md eval set).
    for (const wf of facts.workflowFiles.slice(0, 5)) {
      const yml = await read(wf);
      if (!yml) {
        findings.push(`${wf}: listed in tree but unreadable; cannot verify its steps.`);
        continue;
      }
      const nodePin = yml.match(/node-version\s*:\s*['"]?([^'"\s]+)/i)?.[1] ?? '';
      const javaPin = yml.match(/java-version\s*:\s*['"]?([^'"\s]+)/i)?.[1] ?? '';
      const usesNpmCi = /npm\s+ci/i.test(yml);
      const usesPnpm = /pnpm/i.test(yml);
      const hasChmod = /chmod\s+\+x.*gradlew|update-index\s+--chmod=\+x.*gradlew/i.test(yml);
      const touchesGradle = /gradlew|assembleRelease|assembleDebug/i.test(yml);
      const artifactPath = yml.match(/path\s*:\s*(.+apk[^\s'"]*)/i)?.[1]?.trim() ?? '';

      const bits: string[] = [];
      if (nodePin) bits.push(`node-version=${nodePin}`);
      if (facts.nodeEngines && nodePin && !facts.nodeEngines.includes(nodePin.replace('.x', ''))) {
        findings.push(`${wf}: pins node ${nodePin} but package.json engines want ${facts.nodeEngines}.`);
      }
      if (usesNpmCi && facts.packageManager === 'pnpm') {
        findings.push(`${wf}: runs 'npm ci' but the repo uses pnpm (pnpm-lock.yaml present) — install step will fail or drift.`);
      }
      if (!usesPnpm && facts.packageManager === 'pnpm' && /npm/i.test(yml)) {
        findings.push(`${wf}: repo is pnpm-based; workflow should use pnpm/action-setup + 'pnpm install --frozen-lockfile'.`);
      }
      if (javaPin && !/17/.test(javaPin) && touchesGradle) {
        findings.push(`${wf}: java-version=${javaPin} but Gradle/RN builds need JDK 17.`);
      }
      if (touchesGradle && !hasChmod) {
        findings.push(`${wf}: invokes gradlew without chmod +x — add a chmod step (fails on fresh checkouts).`);
      }
      if (/assembleRelease|assembleDebug/i.test(yml) && !artifactPath) {
        findings.push(`${wf}: builds an APK/AAB but has no upload-artifact path for it — green runs produce nothing to verify.`);
      }
      if (artifactPath) bits.push(`artifact=${artifactPath}`);
      if (!bits.length && !findings.some((f) => f.startsWith(wf))) bits.push('no version pins detected');
      filesRead[filesRead.length - 1].summary = bits.join('; ');
    }
    if (!facts.workflowFiles.length) findings.push('No .github/workflows files: setup-from-scratch case (eval #1).');

    // 2. package.json scripts/engines + workspace manager.
    const pkgRaw = await read('package.json');
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; engines?: { node?: string } };
        const scripts = Object.keys(pkg.scripts ?? {});
        if (!scripts.length) findings.push('package.json has no scripts: nothing for CI to run (add build/test/lint).');
        else filesRead[filesRead.length - 1].summary = `scripts: ${scripts.slice(0, 8).join(', ')}`;
        if (!pkg.engines?.node) findings.push('package.json sets no engines.node: pin it so CI and the workflow agree.');
      } catch {
        findings.push('package.json is not valid JSON.');
      }
    }
    const workspace = await read('pnpm-workspace.yaml');
    if (workspace && !/packages:/i.test(workspace)) findings.push('pnpm-workspace.yaml has no packages: field — workspace may mis-resolve in CI.');

    // 3. Project-type reality check (this target is the proof case).
    if (!facts.isReactNative && !facts.hasAndroid) {
      findings.push(
        `Not React Native: no react-native dep, no android/ dir, yet .github/workflows holds ${facts.workflowFiles.join(', ') || 'nothing'} — read ${facts.workflowFiles[0] ?? 'the workflow'} to see what it actually builds before promising an APK.`,
      );
    }
    if (!findings.length) findings.push('No deterministic issues found; needs LLM diagnosis over the failing log tail.');

    return { filesRead, findings };
  },
);

export interface RunStatus {
  found: boolean;
  runId: number | null;
  runUrl: string;
  status: string;
  conclusion: string | null;
  failingJob: string;
  failingStep: string;
  logTail: string;
  note: string;
}

/** The verification half: what did the workflow actually do? Never claim a failure without this. */
export const getLatestRunStatus = span(
  { kind: 'TOOL', toolName: 'github_check_runs' },
  async (repoUrl: string, branch: string, workflowFile: string): Promise<RunStatus> => {
    const empty: RunStatus = {
      found: false, runId: null, runUrl: '', status: '', conclusion: null,
      failingJob: '', failingStep: '', logTail: '', note: 'No completed runs found.',
    };
    const ctx = parseRepoUrl(repoUrl);
    const octo = getOctokit();
    const fileName = workflowFile.split('/').pop() ?? '';

    let workflowId: number | string = '';
    try {
      const { data } = await octo.actions.listRepoWorkflows({ owner: ctx.owner, repo: ctx.repo, per_page: 50 });
      const match = data.workflows.find((w) => w.path === workflowFile || w.name === fileName || w.path.endsWith('/' + fileName));
      if (!match) return { ...empty, note: `Workflow ${workflowFile} not registered (may never have run).` };
      workflowId = match.id;
    } catch {
      return { ...empty, note: 'Could not list workflows (auth/rate-limit?).' };
    }

    let run: { id: number; html_url: string; status: string; conclusion: string | null } | null = null;
    try {
      const { data } = await octo.actions.listWorkflowRuns({
        owner: ctx.owner, repo: ctx.repo, workflow_id: workflowId, branch, per_page: 5,
      });
      const done = data.workflow_runs.find((r) => r.status === 'completed');
      const latest = data.workflow_runs[0];
      if (!latest) return { ...empty, note: 'Workflow registered but has never run.' };
      if (!done) {
        return { ...empty, runId: latest.id, runUrl: latest.html_url, status: latest.status ?? '', note: `Latest run #${latest.id} is ${latest.status} — not a failure, wait for it.` };
      }
      run = { id: done.id, html_url: done.html_url, status: 'completed', conclusion: done.conclusion };
    } catch {
      return { ...empty, note: 'Could not list workflow runs.' };
    }
    if (!run) return empty;

    if (run.conclusion === 'success') {
      return {
        found: true, runId: run.id, runUrl: run.html_url, status: 'completed', conclusion: 'success',
        failingJob: '', failingStep: '', logTail: '', note: `Run #${run.id} is GREEN — nothing to fix.`,
      };
    }

    // Failed run: find the failing job/step, then fetch that job's log (plaintext, capped).
    try {
      const { data } = await octo.actions.listJobsForWorkflowRun({ owner: ctx.owner, repo: ctx.repo, run_id: run.id, per_page: 30 });
      const failedJob = data.jobs.find((j) => j.conclusion === 'failure') ?? data.jobs[0];
      const failedStep = [...(failedJob.steps ?? [])].reverse().find((s) => s.conclusion === 'failure');
      let logTail = '';
      if (failedJob) {
        const head = await fetch(`https://api.github.com/repos/${ctx.owner}/${ctx.repo}/actions/jobs/${failedJob.id}/logs`, {
          headers: config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {},
          redirect: 'manual',
        });
        const location = head.headers.get('location');
        if (location) {
          const res = await fetch(location);
          const text = await res.text();
          logTail = text.slice(-30000);
        }
      }
      return {
        found: true, runId: run.id, runUrl: run.html_url, status: 'completed', conclusion: run.conclusion,
        failingJob: failedJob?.name ?? '', failingStep: failedStep?.name ?? '',
        logTail, note: `Run #${run.id} ${run.conclusion} in job "${failedJob?.name ?? '?'}" step "${failedStep?.name ?? '?'}".`,
      };
    } catch {
      return { ...empty, runId: run.id, runUrl: run.html_url, status: 'completed', conclusion: run.conclusion, note: 'Run failed but jobs/logs unreadable.' };
    }
  },
);

export const fetchFailingLogTail = span(
  { kind: 'TOOL', toolName: 'github_fetch_run_logs' },
  async (_ctx: GhContext, _runId: number, maxLines = 120): Promise<string> => {
    // Skeleton: full run-watch wiring lands in the next step (trigger/watch).
    // Returns empty so the diagnose path can already be exercised with --log-tail.
    void getOctokit;
    void maxLines;
    return '';
  },
);

export const openFixPr = span(
  { kind: 'TOOL', toolName: 'github_open_pr' },
  async (_ctx: GhContext, _branch: string): Promise<string> => {
    // Skeleton: PR creation lands with the trigger/watch step.
    return 'https://github.com/OWNER/REPO/pull/0 (skeleton)';
  },
);
