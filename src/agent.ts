import { setTraceOutput, span } from 'neatlogs';
import { config } from './config.js';
import { getTracedLlmClient } from './llm.js';
import { analyzeRepo, getLatestRunStatus, inspectRepo, type RepoAnalysis, type RepoFacts, type RunStatus } from './github.js';
import { investigateWithPi, type PiInvestigation } from './pi-loop.js';
import { FIXTURE_NODE_LOG, matchPlaybook, tailLines } from './playbook.js';

export interface FixInput {
  repoUrl: string;
  goal: string;
  logTail: string;
}

export interface FixResult {
  mode: 'playbook' | 'llm' | 'green';
  diagnosis: string;
  fix: string;
  iterations: number;
  verified: boolean;
  facts: RepoFacts;
  analysis: RepoAnalysis;
  investigation: PiInvestigation;
  run: RunStatus;
  logSource: 'cli' | 'run' | 'fixture' | 'none';
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
  async (input: FixInput, facts: RepoFacts, analysis: RepoAnalysis, investigation: PiInvestigation, logTail: string): Promise<Pick<FixResult, 'mode' | 'diagnosis' | 'fix'>> => {
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
  const run = await checkRunsStep(input.repoUrl, facts);

  // Green runs are reported, never "fixed".
  if (run.conclusion === 'success') {
    const green: FixResult = {
      mode: 'green',
      diagnosis: `Workflow green (run #${run.runId}).`,
      fix: `${run.note} See ${run.runUrl}. No changes made.`,
      iterations: 0,
      verified: true,
      facts,
      analysis,
      investigation: { filesRead: [], summary: 'Skipped: run is green.', toolTurns: 0, stoppedWhy: 'finished' },
      run,
      logSource: 'none',
    };
    setTraceOutput(`green: run #${run.runId} @ ${facts.repo}`);
    return green;
  }

  // Log priority: explicit CLI input > real run log > fixture (labeled).
  const logSource: FixResult['logSource'] = input.logTail ? 'cli' : run.logTail ? 'run' : 'fixture';
  const logTail = input.logTail || run.logTail || FIXTURE_NODE_LOG;

  const investigation = await span({ kind: 'AGENT', name: 'investigate' }, async () =>
    investigateWithPi({ repoUrl: input.repoUrl, goal: input.goal, logTail: tailLines(logTail), facts }),
  )();
  const d = await diagnoseStep(input, facts, analysis, investigation, logTail);
  const result: FixResult = {
    ...d,
    iterations: 1,
    // Skeleton verify: real APK-artifact check lands with trigger/watch.
    verified: false,
    facts,
    analysis,
    investigation,
    run,
    logSource,
  };
  setTraceOutput(`${result.mode}(${logSource}): ${result.diagnosis} @ ${facts.repo} (investigator: ${investigation.filesRead.length} files, ${investigation.stoppedWhy})`);
  return result;
});
