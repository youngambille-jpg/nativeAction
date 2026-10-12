import { wrapClaudeAgentSDK, wrapOpenAI } from 'neatlogs';
import OpenAI from 'openai';
import * as claudeAgentSDK from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

let openaiClient: OpenAI | null = null;

/**
 * LLM reasoning path (plan/diagnose): OpenAI-compatible client pointed at
 * the hackathon LiteLLM endpoint. Traced via wrapOpenAI -> LLM spans.
 */
export function getTracedLlmClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const client = new OpenAI({
    apiKey: config.litellmApiKey,
    baseURL: config.litellmBaseUrl || undefined,
  });
  openaiClient = wrapOpenAI(client);
  return openaiClient;
}

/**
 * Agentic execution path (patch/fix): Claude Agent SDK query(), traced via
 * wrapClaudeAgentSDK -> AGENT root with per-turn LLM + TOOL spans.
 * Call once and reuse the returned query.
 */
export function getTracedClaudeQuery(): ReturnType<typeof wrapClaudeAgentSDK>['query'] {
  const { query } = wrapClaudeAgentSDK(claudeAgentSDK);
  return query;
}
