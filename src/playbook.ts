import { span } from 'neatlogs';

export interface PlaybookHit {
  id: string;
  title: string;
  fix: string;
}

/**
 * Fast, deterministic matcher over the failing step's log tail.
 * Tried BEFORE open-ended LLM diagnosis (PLAN.md eval: playbook-first vs LLM-only).
 */
const RULES: Array<{ id: string; title: string; pattern: RegExp; fix: string }> = [
  {
    id: 'node-version-too-old',
    title: 'Node version too old',
    pattern: /(ebadengine|notsup|unsupported engine|required:\s*\{[^}]*node[^}]*\}[\s\S]*current:\s*\{[^}]*node[^}]*\})/is,
    fix: 'Bump actions/setup-node node-version to the version in package.json engines (e.g. 20.x) and re-run.',
  },
  {
    id: 'lockfile-drift',
    title: 'Lockfile out of sync (npm ci fails)',
    pattern: /npm ci.*(out of sync|requires a clean|missing from lock|lock file)/is,
    fix: 'Regenerate the lockfile (npm install) and commit it, or switch install step to npm install as a fallback.',
  },
  {
    id: 'jdk-version',
    title: 'Wrong JDK for Gradle (needs 17)',
    pattern: /(invalid source release|unsupported class file major|requires? (java|jdk) ?17|gradle.*jdk ?11)/is,
    fix: 'Set actions/setup-java java-version to 17 (distribution temurin) for the Gradle job.',
  },
  {
    id: 'gradlew-not-executable',
    title: 'gradlew permission denied',
    pattern: /permission denied.*gradlew|gradlew.*not (found|executable)/is,
    fix: 'Add a step: run: chmod +x android/gradlew (or git update-index --chmod=+x android/gradlew) before the Gradle invocation.',
  },
  {
    id: 'missing-apk-artifact',
    title: 'Green build but no APK artifact',
    pattern: /(no (files|artifacts?) (found|uploaded)|artifact.*(missing|empty|not found))/is,
    fix: 'Fix actions/upload-artifact path to android/app/build/outputs/apk/release/*.apk (verify assembleRelease outputs it).',
  },
];

export const matchPlaybook = span(
  { kind: 'TOOL', toolName: 'match_playbook' },
  async (logTail: string): Promise<PlaybookHit | null> => {
    for (const rule of RULES) {
      if (rule.pattern.test(logTail)) return { id: rule.id, title: rule.title, fix: rule.fix };
    }
    return null;
  },
);

/** Demo fixture: eval case #2 (Node version too old). Last resort when no CLI log and no run logs exist. */
export const FIXTURE_NODE_LOG = [
  'npm warn EBADENGINE Unsupported engine {',
  "npm warn EBADENGINE   package: 'my-rn-app@0.0.1',",
  "npm warn EBADENGINE   required: { node: '>=20 <21' },",
  "npm warn EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }",
  'npm warn EBADENGINE }',
  'error: EBADENGINE install failed',
].join('\n');

/** Cap log context sent to the model: last N lines only (saves $20 shared budget). */
export function tailLines(log: string, maxLines = 120): string {
  const lines = log.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}
