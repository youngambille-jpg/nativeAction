import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { piAgentHooks } from 'neatlogs/pi-agent';
import { config } from './config.js';
import { listTree, readRepoFile, type RepoFacts } from './github.js';

export interface PiInvestigation {
  filesRead: string[];
  summary: string;
  toolTurns: number;
  stoppedWhy: 'finished' | 'turn-cap' | 'error';
}

const MAX_TOOL_TURNS = 10;

function extractText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  let last = '';
  let lastThinking = '';
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== 'assistant') continue;
    const c = msg.content;
    if (typeof c === 'string') {
      last = c;
      continue;
    }
    if (!Array.isArray(c)) continue;
    const text = c
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => ((b as { text?: unknown }).text as string) || '')
      .join('\n')
      .trim();
    const thinking = c
      .filter((b) => (b as { type?: string }).type === 'thinking')
      .map((b) => ((b as { thinking?: unknown }).thinking as string) || '')
      .join('\n')
      .trim();
    if (text) last = text;
    if (thinking) lastThinking = thinking;
  }
  return last || (lastThinking ? `(reasoning only, no final text)\n${lastThinking}` : '');
}

function extractError(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { stopReason?: string; errorMessage?: unknown; content?: unknown };
    if (msg.stopReason === 'error' && typeof msg.errorMessage === 'string' && msg.errorMessage) return msg.errorMessage;
  }
  return '';
}

/**
 * Ready-made Pi Agent loop as the investigator. The MODEL chooses which repo
 * files to open via read-only GitHub-API tools; Pi owns the ReAct turns,
 * context and termination. Traced via piAgentHooks -> AGENT/CHAIN/LLM/TOOL
 * (never wrap Pi-routed calls with wrapOpenAI: that duplicates LLM spans).
 */
export async function investigateWithPi(input: {
  repoUrl: string;
  goal: string;
  logTail: string;
  facts: RepoFacts;
}): Promise<PiInvestigation> {
  if (!config.litellmBaseUrl) throw new Error('LITELLM_BASE_URL is missing (see .env.example).');

  const models = createModels();
  models.setProvider(
    createProvider({
      id: 'litellm',
      name: 'LiteLLM',
      baseUrl: config.litellmBaseUrl,
      auth: { apiKey: envApiKeyAuth('LiteLLM API key', ['LITELLM_API_KEY']) },
      models: [
        {
          id: config.litellmModel,
          name: 'hackathon-model',
          api: 'openai-completions',
          provider: 'litellm',
          baseUrl: config.litellmBaseUrl,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 2048,
          // LiteLLM->Bedrock rejects OpenAI-only params; don't send them.
          compat: { supportsStore: false },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  const model = models.getModel('litellm', config.litellmModel);
  if (!model) throw new Error(`Model ${config.litellmModel} not found in litellm provider`);

  const filesRead: string[] = [];
  const readFile: AgentTool = {
    name: 'github_read_file',
    label: 'Read GitHub file',
    description: `Read a file from ${input.facts.repo} at branch ${input.facts.defaultBranch}. Start with the most relevant file for the goal (workflow YAMLs first: ${input.facts.workflowFiles.join(', ') || 'none'}), then follow leads from what you read. Never re-read a file. Returns the first 6000 chars.`,
    parameters: Type.Object({ path: Type.String({ description: 'Repo-relative file path' }) }),
    execute: async (_id, params) => {
      const p = params as { path: string };
      const content = await readRepoFile(input.repoUrl, p.path, input.facts.defaultBranch);
      if (!content) return { content: [{ type: 'text', text: `MISSING: ${p.path} unreadable. Pick another file.` }], details: {} };
      filesRead.push(p.path);
      return {
        content: [{ type: 'text', text: `FILE ${p.path} (${content.length} chars):\n${content.slice(0, 6000)}` }],
        details: { path: p.path, chars: content.length },
      };
    },
  };
  const listDir: AgentTool = {
    name: 'github_list_tree',
    label: 'List GitHub paths',
    description: 'List up to 40 repo paths under a prefix (e.g. "lib/", "scripts/"). Use to discover files before reading them.',
    parameters: Type.Object({ prefix: Type.String({ description: 'Path prefix' }) }),
    execute: async (_id, params) => {
      const p = params as { prefix: string };
      const paths = await listTree(input.repoUrl, input.facts.defaultBranch, p.prefix, 40);
      return { content: [{ type: 'text', text: `PATHS under ${p.prefix}:\n${paths.join('\n') || '(empty)'}` }], details: {} };
    },
  };

  const agent = piAgentHooks(
    new Agent({
      initialState: {
        systemPrompt: `You investigate GitHub Actions CI failures (read-only). Goal: ${input.goal}. Repo: ${input.repoUrl}. Failing log tail:\n${input.logTail.slice(-800)}\nOpen workflow files and the configs they reference, follow evidence, then write a final summary: what the repo actually builds, what is broken with file-path evidence, and the concrete fix. Cite file paths. Do not claim an APK unless you saw android/ build output and an upload-artifact path. Always finish with a plain-text findings summary (not just reasoning): what builds, what is broken, the concrete fix.`,
        model,
        thinkingLevel: 'medium',
        tools: [readFile, listDir],
        messages: [],
      },
      streamFn: models.streamSimple.bind(models),
    }),
  );

  let toolTurns = 0;
  let stoppedWhy: PiInvestigation['stoppedWhy'] = 'finished';
  agent.subscribe((event) => {
    const t = (event as { type?: string }).type ?? '';
    if (t.includes('tool')) {
      toolTurns += 1;
      if (toolTurns >= MAX_TOOL_TURNS) {
        stoppedWhy = 'turn-cap';
        agent.abort();
      }
    }
  });

  try {
    await agent.prompt(
      `Investigate this CI failure. Known workflow files: ${input.facts.workflowFiles.join(', ') || 'none'}. Start reading.`,
    );
    await agent.waitForIdle();
  } catch (err) {
    stoppedWhy = 'error';
    return { filesRead, summary: `Pi run threw: ${err instanceof Error ? err.message : String(err)}`, toolTurns, stoppedWhy };
  }
  const turnError = extractError(agent.state.messages) || (agent.state as { errorMessage?: unknown }).errorMessage;
  if (typeof turnError === 'string' && turnError) {
    stoppedWhy = 'error';
    return { filesRead, summary: `Pi turn failed: ${turnError.slice(0, 1200)}`, toolTurns, stoppedWhy };
  }
  return { filesRead, summary: extractText(agent.state.messages) || '(no summary text)', toolTurns, stoppedWhy };
}
