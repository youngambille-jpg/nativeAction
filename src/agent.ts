import { setTraceOutput, span } from 'neatlogs';
import { config } from './config.js';
import { getTracedLlmClient } from './llm.js';
import { analyzeRepo, getLatestRunStatus, inspectRepo, listRunArtifacts, mapRepo, pushPatchToBranch, readRepoFile, triggerAndWatch, type RepoAnalysis, type RepoFacts, type RepoMap, type RunStatus } from './github.js';
import { generateWorkflowPatch } from './patch.js';
import { investigateWithPi, type PiInvestigation } from './pi-loop.js';
import { FIXTURE_NODE_LOG, matchPlaybook, tailLines } from './playbook.js';
import { readAgentHistory, type AgentHistory } from './history.js';

export interface FixInput {
  repoUrl: string;
  goal: string;
  logTail: string;
  /** False = dry-run (generate patch only). True = push branch + trigger + watch. */
  apply: boolean;
}

export interface AppliedPatch {
  path: string;
  summary: string;
  changed: boolean;
  attempts: number;
  verified: boolean;
  verifyNotes: string[];
  branch: string | null;
  commitSha: string | null;
  triggeredRunId: number | null;
  triggeredRunUrl: string;
  triggeredConclusion: string | null;
  watchTimedOut: boolean;
}

export interface FixResult {
  mode: 'playbook' | 'llm' | 'green' | 'map';
  diagnosis: string;
  fix: string;
  /** Full human-readable report (repo description for map mode). */
  report: string;
  iterations: number;
  verified: boolean;
  facts: RepoFacts;
  analysis: RepoAnalysis;
  investigation: PiInvestigation;
  run: RunStatus | null;
  map: RepoMap | null;
  logSource: 'cli' | 'run' | 'fixture' | 'none';
  applied: boolean;
  patch: AppliedPatch | null;
  rounds: FixRound[];
  /** What the agent learned from its own Neatlogs traces (or why unavailable). */
  history: string;
}

const isAnalysisGoal = (goal: string): boolean =>
  /analy[sz]e|describe|map\b|overview|what('| i)s (in|inside)|explain|tour|document|summar(y|ize).*(repo|project|code)/i.test(goal);

function buildRepoReport(facts: RepoFacts, analysis: RepoAnalysis, map: RepoMap): string {
  const lines: string[] = [];
  lines.push(`# ${facts.repo} — repo map`);
  lines.push('');
  lines.push(`TypeScript project, ${facts.fileCount} committed files, ${facts.packageManager}-managed${facts.nodeEngines ? `, engines want node ${facts.nodeEngines}` : ' (no engines.node pinned)'}. Default branch ${facts.defaultBranch}.`);
  if (facts.isReactNative) {
    lines.push(`React Native app lives at ${facts.rnRoots.map((r) => `\`${r || '(root)'}\``).join(', ')}.`);
    lines.push(facts.androidDirs.length ? `Android project: ${facts.androidDirs.join(', ')}.` : 'No android/ project anywhere — no APK can be produced from this tree as-is.');
  } else {
    lines.push('No React Native app found at root or nested level.');
  }
  lines.push('');
  lines.push(`## CI (${analysis.workflows.length} workflow${analysis.workflows.length === 1 ? '' : 's'}, ${analysis.errors} errors / ${analysis.warns} warns)`);
  for (const w of analysis.workflows) {
    lines.push(`- \`${w.file}\`: ${w.jobs} job(s), ${w.steps} steps, on [${w.triggers}], runs-on [${w.runsOn}]${w.nodePin ? `, node ${w.nodePin}` : ''}${w.javaPin ? `, java ${w.javaPin}` : ''}${w.buildsApk ? ', builds APK' : ''}${w.uploadsArtifact ? ', uploads artifact' : ''}.`);
  }
  lines.push('');
  lines.push(`## Packages (${map.packages.length})`);
  for (const p of map.packages) {
    lines.push(`- \`${p.dir}\` (${p.name}${p.description ? ` — ${p.description}` : ''}, ${p.depCount} deps): scripts [${p.scripts.join(', ') || 'none'}]${p.hasTests ? ', has tests' : ', NO tests found'}${p.hasReadme ? '' : ', no README'}.`);
  }
  lines.push('');
  lines.push('## Folders (by file count)');
  for (const f of map.folders.slice(0, 12)) {
    const kinds = Object.entries(f.kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${n}×${e}`).join(', ');
    lines.push(`- \`${f.dir}\` — ${f.files} files (${kinds})${f.notable.length ? ` (notable: ${f.notable.map((n) => n.split('/').pop()).join(', ')})` : ''}.`);
    if (f.readme) lines.push(`  > ${f.readme}`);
    if (f.sample.length) lines.push(`  > contains: ${f.sample.join(', ')}`);
  }
  if (map.entryPoints.length) {
    lines.push('');
    lines.push(`Likely entry points: ${map.entryPoints.map((e) => `\`${e}\``).join(', ')}.`);
  }
  if (facts.largest.length) {
    lines.push('');
    lines.push(`Largest files: ${facts.largest.slice(0, 5).map((l) => `\`${l.path}\` (${Math.round(l.size / 1024)}KB)`).join(', ')}.`);
  }
  if (analysis.findings.length) {
    lines.push('');
    lines.push('## CI findings');
    for (const f of analysis.findings) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

const inspectStep = span({ kind: 'AGENT', name: 'inspect' }, async (repoUrl: string): Promise<RepoFacts> => {
  return inspectRepo(repoUrl);
});

const analyzeStep = span(
  { kind: 'AGENT', name: 'analyze' },
  async (repoUrl: string, facts: RepoFacts): Promise<RepoAnalysis> => {
    // Loops through workflow YAMLs + package.json/workspace, one TOOL span
    // per file read inside analyzeRepo, then returns deterministic findings.
    return analyzeRepo(repoUrl, facts);
  },
);

/** One grounded narrative pass over the deterministic map: what the project is,
 * how the pieces connect, what each area is for. Falls back to '' (deterministic report stands alone). */
const narrateStep = span(
  { kind: 'AGENT', name: 'narrate' },
  async (goal: string, facts: RepoFacts, analysis: RepoAnalysis, map: RepoMap): Promise<string> => {
    try {
      const client = getTracedLlmClient();
      const mapJson = JSON.stringify(
        { packages: map.packages, entryPoints: map.entryPoints, folders: map.folders.slice(0, 15), docs: map.docs },
        null, 1,
      ).slice(0, 5000);
      const res = await client.chat.completions.create({
        model: config.litellmModel,
        messages: [
          {
            role: 'user',
            content: `Describe this repository for a developer joining the team. Goal behind the request: "${goal}". Be concrete and cite paths. Cover: (1) what the project is and does, (2) architecture — how the packages/services connect, (3) what each major area is for, (4) mobile/CI story in one line, (5) biggest gaps you see (tests? docs?). Reply in markdown, under 400 words. Do not invent files; only use what is below.\n\nRepo: ${facts.repo} (${facts.fileCount} files, ${facts.packageManager}). RN roots: ${facts.rnRoots.join(', ') || 'none'}. Android dirs: ${facts.androidDirs.join(', ') || 'none'}. Workflows: ${analysis.workflows.map((w) => `${w.file} (${w.steps} steps, on ${w.triggers})`).join('; ') || 'none'}. CI findings: ${analysis.findings.join(' | ').slice(0, 800)}\n\nMAP:\n${mapJson}`,
          },
        ],
        max_tokens: 900,
      });
      return res.choices[0]?.message?.content?.trim() || '';
    } catch {
      return '';
    }
  },
);

export interface FixRound {
  n: number;
  branch: string;
  patchSummary: string;
  triggeredRunId: number;
  triggeredRunUrl: string;
  conclusion: string | null;
  artifacts: string[];
  artifactFound: boolean;
  verified: boolean;
  logSource: string;
}

const MAX_FIX_ITERS = 3;

/** The agent reading its own Neatlogs traces before acting. Degrades to a
 * labeled gap when read credentials are absent (human-gated). */
const reflectStep = span(
  { kind: 'AGENT', name: 'reflect' },
  async (): Promise<AgentHistory> => readAgentHistory(8),
);

const checkRunsStep = span(
  { kind: 'AGENT', name: 'verify_runs' },
  async (repoUrl: string, facts: RepoFacts): Promise<RunStatus> => {
    if (!facts.workflowFiles.length) {
      return {
        found: false, runId: null, runUrl: '', status: '', conclusion: null,
        failingJob: '', failingStep: '', logTail: '', note: 'No workflow files: nothing has ever run.',
      };
    }
    return getLatestRunStatus(repoUrl, facts.defaultBranch, facts.workflowFiles[0]);
  },
);

const planStep = span(
  { kind: 'AGENT', name: 'plan' },
  async (input: FixInput, facts: RepoFacts, analysis: RepoAnalysis, investigation: PiInvestigation, logTail: string): Promise<string> => {
    const client = getTracedLlmClient();
    // Single user message (no leading system role): some Bedrock-backed
    // LiteLLM routes reject conversations that don't start with user.
    const res = await client.chat.completions.create({
      model: config.litellmModel,
      messages: [
        {
          role: 'user',
          content: `You plan minimal GitHub Actions fixes. First state what the repo actually is (React Native Android or not) from the facts. If it is not React Native, say so and plan the generic Node CI fix instead of promising an APK. Reply in 4 short bullets: repo reality, what broke, what file to change, how to verify.\n\nRepo: ${input.repoUrl}\nGoal: ${input.goal}\nRepo facts:\n${JSON.stringify(facts, null, 2)}\nDeterministic checks:\n- ${analysis.findings.join('\n- ')}\nInvestigator (${investigation.toolTurns} tool turns, ${investigation.stoppedWhy}, read: ${investigation.filesRead.join(', ') || 'none'}):\n${investigation.summary}\nFailing log tail:\n${tailLines(logTail)}`,
        },
      ],
      max_tokens: 400,
    });
    return res.choices[0]?.message?.content?.trim() || '(empty plan)';
  },
);

const diagnoseStep = span(
  { kind: 'AGENT', name: 'diagnose' },
  async (input: FixInput, facts: RepoFacts, analysis: RepoAnalysis, investigation: PiInvestigation, logTail: string, logSource: FixResult['logSource']): Promise<Pick<FixResult, 'mode' | 'diagnosis' | 'fix'>> => {
    // Synthetic log? Diagnose the FILE evidence, not the fixture: the fixture
    // describes a failure this repo may not have, while analysis holds real errors.
    if (logSource === 'fixture') {
      const errs = analysis.findings.filter((f) => f.startsWith('[error]')).slice(0, 4);
      if (errs.length) {
        return {
          mode: 'playbook',
          diagnosis: `File-evidence diagnosis (${errs.length} deterministic errors): ${errs.join(' ')}`,
          fix: errs.join('\n'),
        };
      }
    }
    // Playbook first (deterministic, $0). File findings + Pi evidence sharpen the fix text.
    const hit = await matchPlaybook(tailLines(logTail));
    if (hit) {
      const scope = facts.isReactNative ? hit.fix : `${hit.fix} Repo is not React Native, so verify against its ${facts.packageManager || 'npm'} setup, not an APK.`;
      const extra = analysis.findings.length ? `\nDeterministic findings:\n- ${analysis.findings.join('\n- ')}` : '';
      const inv = investigation.filesRead.length
        ? `\nPi investigator read (${investigation.toolTurns} tool turns): ${investigation.filesRead.join(', ')}.\n${investigation.summary}`
        : '';
      return { mode: 'playbook', diagnosis: hit.title, fix: `${scope}${extra}${inv}` };
    }

    const plan = await planStep(input, facts, analysis, investigation, logTail);
    return { mode: 'llm', diagnosis: plan, fix: plan };
  },
);

/**
 * WORKFLOW root: one trace per fix run. LLM calls (wrapOpenAI) and TOOL
 * spans (github_inspect_repo, match_playbook, github_*) nest under it.
 */
export const runFix = span({ kind: 'WORKFLOW', name: 'actionsforge-fix' }, async (input: FixInput): Promise<FixResult> => {
  const facts = await inspectStep(input.repoUrl);
  const analysis = await analyzeStep(input.repoUrl, facts);

  // Analysis goals ("analyse this repo") get a full map + description,
  // never a fix verdict and never a run gate.
  if (isAnalysisGoal(input.goal)) {
    const map = await span({ kind: 'AGENT', name: 'describe' }, async () =>
      mapRepo(input.repoUrl, facts, analysis),
    )();
    const deterministic = buildRepoReport(facts, analysis, map);
    const narrative = await narrateStep(input.goal, facts, analysis, map);
    const report = narrative ? `## In brief\n\n${narrative}\n\n---\n\n${deterministic}` : deterministic;
    const described: FixResult = {
      mode: 'map',
      diagnosis: `${facts.repo}: ${facts.fileCount} files, ${map.packages.length} packages, ${analysis.workflows.length} workflows.`,
      fix: 'Analysis only — no changes made. See report.',
      report,
      iterations: 0,
      verified: false,
      facts,
      analysis,
      investigation: { filesRead: [], summary: 'Skipped: analysis goal.', toolTurns: 0, stoppedWhy: 'finished' },
      run: null,
      map,
      logSource: 'none',
      applied: false,
      patch: null,
      rounds: [],
      history: 'Skipped: analysis goal.',
    };
    setTraceOutput(`map: ${facts.repo} (${map.packages.length} pkgs, ${map.folders.length} dirs)`);
    return described;
  }

  const run = await checkRunsStep(input.repoUrl, facts);

  // Green runs are reported, never "fixed".
  if (run.conclusion === 'success') {
    const green: FixResult = {
      mode: 'green',
      diagnosis: `Workflow green (run #${run.runId}).`,
      fix: `${run.note} See ${run.runUrl}. No changes made.`,
      report: '',
      iterations: 0,
      verified: true,
      facts,
      analysis,
      investigation: { filesRead: [], summary: 'Skipped: run is green.', toolTurns: 0, stoppedWhy: 'finished' },
      run,
      map: null,
      logSource: 'none',
      applied: false,
      patch: null,
      rounds: [],
      history: 'Skipped: run is green.',
    };
    setTraceOutput(`green: run #${run.runId} @ ${facts.repo}`);
    return green;
  }

  // Log priority: explicit CLI input > real run log > fixture (labeled).
  const logSource: FixResult['logSource'] = input.logTail ? 'cli' : run.logTail ? 'run' : 'fixture';
  const logTail = input.logTail || run.logTail || FIXTURE_NODE_LOG;

  // Self-reflection: read our own Neatlogs traces before acting.
  const history = await reflectStep();

  const investigation = await span({ kind: 'AGENT', name: 'investigate' }, async () =>
    investigateWithPi({ repoUrl: input.repoUrl, goal: input.goal, logTail: tailLines(logTail), logProvenance: logSource, history: history.summary, facts }),
  )();
  const d = await diagnoseStep(input, facts, analysis, investigation, logTail, logSource);

  // Steps 1-3: generate the patch; push + trigger + watch only with --apply.
  let patch: AppliedPatch | null = null;
  let applied = false;
  if ((d.mode === 'playbook' || d.mode === 'llm') && facts.workflowFiles.length) {
    const target = facts.workflowFiles[0];
    const current = await readRepoFile(input.repoUrl, target, facts.defaultBranch, 12000);
    const gen = await generateWorkflowPatch({ path: target, current, diagnosis: d.diagnosis, fix: d.fix, nodeEngines: facts.nodeEngines });
    patch = {
      path: gen.path, summary: gen.summary, changed: gen.changed,
      attempts: gen.attempts, verified: gen.verified, verifyNotes: gen.verifyNotes,
      branch: null, commitSha: null, triggeredRunId: null,
      triggeredRunUrl: '', triggeredConclusion: null, watchTimedOut: false,
    };
    if (input.apply && gen.changed) {
      // Outer recovery loop: push -> trigger -> watch the REAL run -> feed its
      // logs back into diagnose/regenerate -> repeat. Final verification is
      // green conclusion AND an apk/aab artifact on the fix branch.
      const branch = `actionsforge/fix-${run.runId ?? Date.now()}`;
      const rounds: FixRound[] = [];
      let branchContent = gen.newContent;
      let curDiag: { mode: FixResult['mode']; diagnosis: string; fix: string } = { mode: d.mode, diagnosis: d.diagnosis, fix: d.fix };
      let curLog = logTail;
      let curSrc: FixResult['logSource'] = logSource;
      let lastGen = gen;
      let lastSha = '';
      let finalVerified = false;
      for (let n = 1; n <= MAX_FIX_ITERS; n++) {
        if (n > 1) {
          lastGen = await generateWorkflowPatch({ path: target, current: branchContent, diagnosis: curDiag.diagnosis, fix: curDiag.fix, nodeEngines: facts.nodeEngines });
          if (lastGen.changed) branchContent = lastGen.newContent;
        }
        const pushed = await pushPatchToBranch(input.repoUrl, facts.defaultBranch, branch, target, branchContent, `fix(ci): ${lastGen.summary} (round ${n})`);
        lastSha = pushed.commitSha;
        const watched = await triggerAndWatch(input.repoUrl, target, branch, branch);
        let artifactFound = false;
        let artifacts: string[] = [];
        let roundLog = '';
        if (!watched.timedOut && watched.runId) {
          artifacts = await listRunArtifacts(input.repoUrl, watched.runId);
          artifactFound = artifacts.some((a) => /\.apk$|\.aab$/i.test(a));
          const st = await getLatestRunStatus(input.repoUrl, branch, target);
          roundLog = st.logTail;
        }
        const ok = watched.conclusion === 'success' && artifactFound && !watched.timedOut;
        rounds.push({
          n, branch, patchSummary: lastGen.summary, triggeredRunId: watched.runId,
          triggeredRunUrl: watched.runUrl, conclusion: watched.conclusion,
          artifacts: artifacts.slice(0, 10), artifactFound, verified: ok, logSource: curSrc,
        });
        if (ok) {
          finalVerified = true;
          break;
        }
        if (watched.timedOut || !roundLog) break;
        curLog = roundLog;
        curSrc = 'run';
        curDiag = await diagnoseStep(input, facts, analysis, investigation, curLog, curSrc);
      }
      patch = {
        path: target, summary: lastGen.summary, changed: true,
        attempts: lastGen.attempts, verified: finalVerified, verifyNotes: lastGen.verifyNotes,
        branch, commitSha: lastSha,
        triggeredRunId: rounds[rounds.length - 1]?.triggeredRunId ?? null,
        triggeredRunUrl: rounds[rounds.length - 1]?.triggeredRunUrl ?? '',
        triggeredConclusion: rounds[rounds.length - 1]?.conclusion ?? null,
        watchTimedOut: rounds.some((r) => r.triggeredRunId === 0),
      };
      applied = true;
      const result: FixResult = {
        mode: curDiag.mode as FixResult['mode'], diagnosis: curDiag.diagnosis, fix: curDiag.fix,
        report: '',
        iterations: rounds.length,
        verified: finalVerified,
        facts, analysis, investigation, run, map: null, logSource: curSrc,
        applied, patch, rounds, history: history.summary,
      };
      setTraceOutput(`${finalVerified ? 'fixed' : 'unfixed'}(${rounds.length} rounds): ${curDiag.diagnosis} @ ${facts.repo} branch ${branch}`);
      return result;
    }
  }

  const result: FixResult = {
    ...d,
    report: '',
    iterations: 1,
    verified: false,
    facts,
    analysis,
    investigation,
    run,
    map: null,
    logSource,
    applied,
    patch,
    rounds: [],
    history: history.summary,
  };
  setTraceOutput(`${result.mode}(${logSource}): ${result.diagnosis} @ ${facts.repo} (investigator: ${investigation.filesRead.length} files, ${investigation.stoppedWhy})`);
  return result;
});
