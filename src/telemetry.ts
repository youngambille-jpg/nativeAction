import { flush, init, shutdown } from 'neatlogs';
import { config } from './config.js';

/** One-shot script lifecycle: init once at startup, flush+shutdown in finally. */
export async function initTelemetry(workflowName: string): Promise<void> {
  await init({
    apiKey: config.neatlogsApiKey || process.env.NEATLOGS_API_KEY,
    endpoint: config.neatlogsEndpoint,
    workflowName,
  });
}

export async function drainTelemetry(): Promise<void> {
  await flush();
  await shutdown();
}
