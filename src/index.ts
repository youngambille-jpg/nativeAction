import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { drainTelemetry, initTelemetry } from './telemetry.js';
import { runFix } from './agent.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  await initTelemetry('actionsforge-fix');
  try {
    const repoUrl = arg('repo', 'https://github.com/OWNER/REPO');
    const goal = arg('goal', 'make React Native Android APK build on every push to main');
    const logFile = arg('log-file');
    // Empty unless explicitly supplied: the agent prefers the real run log,
    // falling back to the fixture only when the workflow never ran.
    const logTail = logFile ? readFileSync(logFile, 'utf8') : arg('log-tail');
    const apply = process.argv.includes('--apply');

    const result = await runFix({ repoUrl, goal, logTail, apply });
    console.log(JSON.stringify({ traceWorkflow: 'actionsforge-fix', ...result }, null, 2));
  } finally {
    await drainTelemetry();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
