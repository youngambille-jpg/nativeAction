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
  /** Subdirs whose package.json depends on react-native ('' = root). */
  rnRoots: string[];
  hasAndroid: boolean;
  /** All dirs containing an android app (android/gradlew or android/app). */
  androidDirs: string[];
  hasIos: boolean;
  nodeEngines: string;
  packageManager: string;
  workflowFiles: string[];
  topLevel: string[];
  fileCount: number;
  /** Largest committed files (path + bytes), lockfiles excluded. */
  largest: Array<{ path: string; size: number }>;
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
    const sizes = new Map((tree.tree ?? []).map((t) => [t.path ?? '', t.size ?? 0] as const));
    const known = new Set(paths);
    const has = (p: string) => paths.some((x) => x === p || x.startsWith(p + '/'));
    const text = async (path: string): Promise<string> => {
      if (!known.has(path)) return '';
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
    const rnRoots: string[] = [];
    const depHit = (raw: string): boolean => {
      try {
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        return 'react-native' in deps || '@react-native-community/cli' in deps;
      } catch {
        return false;
      }
    };
    if (depHit(pkgRaw)) rnRoots.push('');
    try {
      const pkg = JSON.parse(pkgRaw || '{}') as {
        engines?: { node?: string };
        packageManager?: string;
      };
      nodeEngines = pkg.engines?.node ?? '';
      // Normalize "yarn@1.22.19" -> "yarn": CI steps name the tool, not the version.
      packageManager = (pkg.packageManager ?? '').split('@')[0] || (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm');
    } catch {
      // leave defaults
    }
    // Deep scan: nested apps (monorepos) keep react-native + android/ away from root.
    const nestedPkgs = paths
      .filter((p) => p.endsWith('/package.json') && !p.includes('node_modules') && p.split('/').length <= 4)
      .slice(0, 8);
    for (const np of nestedPkgs) {
      const raw = await text(np);
      if (raw && depHit(raw)) rnRoots.push(np.slice(0, -'/package.json'.length));
    }
    const androidDirs = [...new Set(
      paths
        .filter((p) => /(^|\/)android\/(gradlew|app\/build\.gradle|app\/src\/)/.test(p))
        .map((p) => p.slice(0, p.indexOf('android/') + 'android'.length)),
    )].slice(0, 8);
    const isReactNative = rnRoots.length > 0;
    const workflowFiles = paths.filter((p) => p.startsWith('.github/workflows/')).slice(0, 20);

    const facts: RepoFacts = {
      repo: `${ctx.owner}/${ctx.repo}`,
      defaultBranch: branch,
      languages: [repo.language ?? 'unknown'],
      isReactNative,
      rnRoots,
      hasAndroid: has('android'),
      androidDirs,
      hasIos: has('ios'),
      nodeEngines,
      packageManager,
      workflowFiles,
      topLevel: [...new Set(paths.map((p) => p.split('/')[0]))].slice(0, 30),
      fileCount: paths.length,
      largest: paths
        .filter((p) => !/lock\.yaml$|\.lock$|pnpm-lock/.test(p))
        .map((p) => ({ path: p, size: sizes.get(p) ?? 0 }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 10),
      note:
        !isReactNative && !androidDirs.length
          ? 'Not a React Native Android project: no react-native dependency in root or nested package.json files, and no android/ app dir at any depth. Treat as generic Node/TS; do not promise an APK.'
          : isReactNative
            ? `React Native app found at: ${rnRoots.map((r) => r || '(root)').join(', ')}. Android dirs: ${androidDirs.join(', ') || 'none'}.`
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
  /** Rendered findings, prefixed [error]/[warn]/[info]. Deterministic, $0. */
  findings: string[];
  workflows: WorkflowBrief[];
  errors: number;
  warns: number;
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

export type Severity = 'error' | 'warn' | 'info';

export interface WorkflowBrief {
  file: string;
  jobs: number;
  steps: number;
  triggers: string;
  runsOn: string;
  nodePin: string;
  javaPin: string;
  packageManagerInCi: string;
  buildsApk: boolean;
  uploadsArtifact: boolean;
}

export interface RepoAnalysis {
  filesRead: FileFinding[];
  /** Rendered findings, prefixed [error]/[warn]/[info]. Deterministic, $0. */
  findings: string[];
  workflows: WorkflowBrief[];
  errors: number;
  warns: number;
}

const err = (file: string, message: string): string => `[error] ${file}: ${message}`;
const warn = (file: string, message: string): string => `[warn] ${file}: ${message}`;
const info = (file: string, message: string): string => `[info] ${file}: ${message}`;

interface WfStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Deep deterministic analysis: parses workflow YAML structurally (not regex),
 * follows the files the workflow references (CI configs, gradle files, app
 * manifests), and grades package.json scripts. Everything here is free and
 * feeds the Pi investigator + diagnose steps as evidence.
 */
export const analyzeRepo = span(
  { kind: 'TOOL', toolName: 'github_analyze_files' },
  async (repoUrl: string, facts: RepoFacts): Promise<RepoAnalysis> => {
    const { parse } = await import('yaml');
    const findings: string[] = [];
    const workflows: WorkflowBrief[] = [];
    const filesRead: FileFinding[] = [];
    const read = async (path: string, maxChars = 8000): Promise<string> => {
      if (!allPaths.has(path)) {
        filesRead.push({ path, chars: 0, summary: 'absent from tree (no request sent)' });
        return '';
      }
      const content = await readRepoFile(repoUrl, path, facts.defaultBranch, maxChars);
      filesRead.push({
        path,
        chars: content.length,
        summary: content ? `read ${content.length} chars` : 'missing/unreadable',
      });
      return content;
    };
    const last = (): FileFinding => filesRead[filesRead.length - 1];
    // One bounded tree listing so lead-following never fires 404s.
    const allPaths = new Set(await listTree(repoUrl, facts.defaultBranch, '', 2000));

    // 1. Workflow files, parsed as YAML.
    for (const wf of facts.workflowFiles.slice(0, 5)) {
      const raw = await read(wf, 12000);
      if (!raw) {
        findings.push(err(wf, 'listed in tree but unreadable; cannot verify its steps.'));
        continue;
      }
      let doc: any = null;
      try {
        doc = parse(raw);
      } catch {
        findings.push(err(wf, 'is not valid YAML — Actions will refuse to run it.'));
        continue;
      }
      const jobs: Record<string, any> = doc?.jobs ?? {};
      const jobNames = Object.keys(jobs);
      const steps: WfStep[] = jobNames.flatMap((j) => (Array.isArray(jobs[j]?.steps) ? jobs[j].steps : []));
      const on = doc?.on;
      const triggers = typeof on === 'string' ? on : Array.isArray(on) ? on.join(',') : on ? Object.keys(on).join(',') : 'none';
      const runsOn = [...new Set(jobNames.map((j) => str(jobs[j]?.['runs-on']).replace(/["{}]/g, '')))].filter(Boolean).join(',') || 'unset';
      const brief: WorkflowBrief = {
        file: wf, jobs: jobNames.length, steps: steps.length, triggers, runsOn,
        nodePin: '', javaPin: '', packageManagerInCi: '', buildsApk: false, uploadsArtifact: false,
      };

      if (!jobNames.length) findings.push(err(wf, 'defines no jobs.'));
      if (!triggers || triggers === 'none') findings.push(err(wf, 'has no `on:` trigger — it will never run.'));
      if (!/push/.test(triggers)) findings.push(warn(wf, `trigger (${triggers}) won't run on push to main — goal requires push coverage.`));
      if (!/ubuntu/.test(runsOn)) findings.push(warn(wf, `runs on [${runsOn || 'unset'}]; Android builds expect ubuntu-latest.`));
      if (doc?.permissions == null && !doc?.jobs) findings.push(info(wf, 'no top-level permissions block; GITHUB_TOKEN gets broad defaults.'));
      for (const j of jobNames) {
        if (jobs[j]?.['timeout-minutes'] == null && /gradlew|assemble/i.test(JSON.stringify(jobs[j]))) {
          findings.push(warn(wf, `job "${j}" builds Android with no timeout-minutes — a stuck Gradle run burns minutes until the 6h default.`));
        }
      }

      let nodePin = '', javaPin = '', pmInCi = '';
      let chmodIdx = -1, gradleIdx = -1;
      steps.forEach((s, i) => {
        const uses = str(s.uses);
        const run = str(s.run);
        if (/setup-node/i.test(uses)) nodePin = str(s.with?.['node-version']);
        if (/setup-java/i.test(uses)) javaPin = str(s.with?.['java-version']);
        if (/pnpm\/action-setup/i.test(uses)) pmInCi = 'pnpm';
        if (/\bzuela(.+)?\/setup-node/i.test(uses)) pmInCi = pmInCi || 'node';
        if (/npm\s+ci/.test(run)) pmInCi = pmInCi || 'npm';
        if (/pnpm\s+(install|ci|add)/.test(run)) pmInCi = 'pnpm';
        if (/yarn/.test(run) && !pmInCi) pmInCi = 'yarn';
        if (/chmod\s+\+x.*gradlew|update-index\s+--chmod=\+x/i.test(run)) chmodIdx = i;
        if (/gradlew\s+(assemble|bundle|test|connected)/i.test(run)) gradleIdx = i;
        const v = uses.match(/@v(\d+)/)?.[1];
        if (uses && v && Number(v) < 4 && /actions\/(checkout|setup-node|setup-java|upload-artifact|download-artifact)/.test(uses)) {
          findings.push(info(wf, `"${uses}" predates v4 — works, but pin to v4+ for cache/security fixes.`));
        }
      });
      brief.nodePin = nodePin; brief.javaPin = javaPin; brief.packageManagerInCi = pmInCi;
      brief.buildsApk = steps.some((s) => /gradlew\s+(assemble|bundle)/i.test(str(s.run)));
      brief.uploadsArtifact = steps.some((s) => /upload-artifact/i.test(str(s.uses)));

      if (facts.nodeEngines && nodePin && !facts.nodeEngines.includes(nodePin.replace(/\.x$/, ''))) {
        findings.push(err(wf, `pins node ${nodePin} but package.json engines want ${facts.nodeEngines}.`));
      }
      if (!nodePin && steps.some((s) => /node|npm|pnpm|yarn/i.test(str(s.run) + str(s.uses)))) {
        findings.push(warn(wf, 'runs JS tooling without actions/setup-node — runner default Node is unpredictable.'));
      }
      if (pmInCi && pmInCi !== facts.packageManager) {
        findings.push(err(wf, `installs with ${pmInCi} but the repo locks with ${facts.packageManager} — deps will drift or the step fails.`));
      }
      if (facts.packageManager === 'pnpm' && !steps.some((s) => /pnpm\/action-setup/i.test(str(s.uses)))) {
        findings.push(warn(wf, `repo is pnpm-based but no pnpm/action-setup step; add it with cache for install speed.`));
      }
      if (javaPin && !/17/.test(javaPin) && gradleIdx >= 0) {
        findings.push(err(wf, `java-version=${javaPin} but Gradle/RN Android builds need JDK 17.`));
      }
      if (!javaPin && gradleIdx >= 0) {
        findings.push(warn(wf, 'invokes Gradle without actions/setup-java — runner JDK is unpredictable.'));
      }
      if (gradleIdx >= 0 && chmodIdx < 0) {
        findings.push(err(wf, 'invokes gradlew without chmod +x (fails on fresh checkouts) — add `chmod +x android/gradlew` first.'));
      }
      if (gradleIdx >= 0 && chmodIdx > gradleIdx) {
        findings.push(err(wf, 'chmod step comes AFTER the gradle invocation — reorder it before.'));
      }
      if (brief.buildsApk && !brief.uploadsArtifact) {
        findings.push(err(wf, 'assembles APK/AAB but never uploads it — green runs produce nothing to verify (eval case #6).'));
      }
      const artStep = steps.find((s) => /upload-artifact/i.test(str(s.uses)));
      if (artStep && !/\.apk|\.aab|outputs/i.test(JSON.stringify(artStep.with ?? {}))) {
        findings.push(warn(wf, 'upload-artifact path does not look like an APK/AAB output dir — verify it matches the Gradle output.'));
      }
      last().summary = `jobs:${brief.jobs} steps:${brief.steps} on:[${triggers}] runs-on:[${runsOn}]${nodePin ? ` node=${nodePin}` : ''}${javaPin ? ` java=${javaPin}` : ''}${brief.buildsApk ? ' builds-apk' : ''}${brief.uploadsArtifact ? ' uploads-artifact' : ''}`;
      workflows.push(brief);
    }
    if (!facts.workflowFiles.length) findings.push(err('repo', 'No .github/workflows files: setup-from-scratch case (eval #1).'));

    // 2. package.json, graded by role.
    const pkgRaw = await read('package.json');
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as {
          scripts?: Record<string, string>;
          engines?: { node?: string };
          packageManager?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const has = (...names: string[]): string => names.find((n) => n in scripts) ?? '';
        const roles: Array<[string, string[]]> = [
          ['build', ['build', 'build:android', 'assembleRelease']],
          ['test', ['test', 'test:ci', 'jest']],
          ['lint', ['lint', 'lint:ci']],
          ['typecheck', ['typecheck', 'tsc', 'type-check']],
          ['e2e', ['e2e', 'detox', 'maestro']],
        ];
        const missing = roles.filter(([, names]) => !has(...names)).map(([r]) => r);
        if (missing.length) findings.push(warn('package.json', `no scripts for: ${missing.join(', ')} — CI can only run what exists.`));
        last().summary = `scripts: ${Object.keys(scripts).slice(0, 10).join(', ') || 'none'}`;
        if (!pkg.engines?.node) findings.push(warn('package.json', 'sets no engines.node: pin it so CI and the workflow agree.'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        if ('expo' in deps && !facts.workflowFiles.some((w) => w.includes('eas'))) {
          findings.push(info('package.json', 'Expo project without an EAS workflow — `expo prebuild`/EAS Build may be the intended path.'));
        }
      } catch {
        findings.push(err('package.json', 'is not valid JSON.'));
      }
    }

    // 3. Follow the leads the workflow references (bounded: only files in the tree).
    // App manifests live beside the app — check each RN root too, not just repo root.
    const extras = [
      'codemagic.yaml', 'eas.json', 'app.json', 'expo.json', 'pnpm-workspace.yaml',
      ...facts.rnRoots.filter(Boolean).flatMap((r) => [`${r}/app.json`, `${r}/eas.json`, `${r}/expo.json`, `${r}/metro.config.js`]),
    ];
    for (const e of extras) {
      const content = await read(e);
      if (!content) continue;
      if (e === 'pnpm-workspace.yaml' && !/packages:/i.test(content)) {
        findings.push(warn(e, 'has no packages: field — workspace may mis-resolve in CI.'));
      }
      if ((e === 'app.json' || e === 'expo.json') && !/android/i.test(content)) {
        findings.push(info(e, 'declares no android config — APK output needs an android profile.'));
      }
    }
    for (const dir of facts.androidDirs.slice(0, 2)) {
      const props = await read(`${dir}/gradle.properties`);
      if (props && !/org\.gradle\.jvmargs/i.test(props)) {
        findings.push(info(`${dir}/gradle.properties`, 'no org.gradle.jvmargs — large RN builds OOM without heap tuning.'));
      }
      const appGradle = await read(`${dir}/app/build.gradle`);
      if (appGradle) {
        const appId = appGradle.match(/applicationId\s+["']([^"']+)["']/)?.[1] ?? '';
        if (!appId) findings.push(warn(`${dir}/app/build.gradle`, 'no applicationId found — APK cannot be signed/published without it.'));
      }
    }

    // 4. Project-type reality check (deep: root + nested apps + any-depth android/).
    if (!facts.isReactNative && !facts.androidDirs.length) {
      findings.push(
        warn('repo', `Not React Native: no react-native dep in root or nested package.json, no android/ app dir at any depth, yet workflows hold ${facts.workflowFiles.join(', ') || 'nothing'} — artifact claims need scrutiny before promising an APK.`),
      );
    } else if (facts.isReactNative) {
      findings.push(
        info('repo', `React Native app at ${facts.rnRoots.map((r) => r || '(root)').join(', ')}; android dirs: ${facts.androidDirs.join(', ') || 'NONE — APK build impossible until the android/ project exists'}.`),
      );
    }
    if (!findings.length) findings.push(info('repo', 'No deterministic issues found; needs LLM diagnosis over the failing log tail.'));

    const errors = findings.filter((f) => f.startsWith('[error]')).length;
    const warns = findings.filter((f) => f.startsWith('[warn]')).length;
    return { filesRead, findings, workflows, errors, warns };
  },
);

export interface FolderMap {
  dir: string;
  files: number;
  /** Count by file extension, e.g. {ts: 40, md: 3}. */
  kinds: Record<string, number>;
  notable: string[];
  /** Full listing when the folder is small enough to show everything. */
  sample: string[];
  /** First 400 chars of the folder README, if it has one. */
  readme: string;
}

export interface PackageMap {
  dir: string;
  name: string;
  description: string;
  scripts: string[];
  depCount: number;
  hasReadme: boolean;
  hasTests: boolean;
}

export interface DocDigest {
  path: string;
  excerpt: string;
}

export interface RepoMap {
  folders: FolderMap[];
  packages: PackageMap[];
  entryPoints: string[];
  docFiles: string[];
  /** Excerpts of the most informative docs (READMEs, root *.md), capped. */
  docs: DocDigest[];
}

/**
 * File-by-file, folder-by-folder map of what's inside the repo. Deterministic:
 * groups the tree, summarizes every workspace package, lists CI + docs +
 * probable entry points. Built for analysis goals ("analyse this repo").
 */
export const mapRepo = span(
  { kind: 'TOOL', toolName: 'github_map_repo' },
  async (repoUrl: string, facts: RepoFacts, analysis: RepoAnalysis): Promise<RepoMap> => {
    const all = await listTree(repoUrl, facts.defaultBranch, '', 2000);
    const inTree = new Set(all);
    const byDir = new Map<string, string[]>();
    for (const p of all) {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '(root)';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)?.push(p);
    }
    const extOf = (p: string): string => {
      const base = p.split('/').pop() ?? '';
      const i = base.lastIndexOf('.');
      return i > 0 ? base.slice(i + 1).toLowerCase() : '(no-ext)';
    };
    const readIfPresent = async (path: string, maxChars: number): Promise<string> =>
      inTree.has(path) ? readRepoFile(repoUrl, path, facts.defaultBranch, maxChars) : '';
    const notablePat = /(read ?me|license|contribut|code_of_conduct|dockerfile|compose\.ya?ml|\.replit|codemagic\.ya?ml|eas\.json|app\.json|expo\.json|package\.json|tsconfig|eslint|prettier|jest\.config|vitest|playwright|detox|maestro|fastfile|appfile|gradlew|podfile|metro\.config|babel\.config)/i;
    const folders: FolderMap[] = [];
    for (const [dir, files] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
      const kinds: Record<string, number> = {};
      for (const f of files) {
        const e = extOf(f);
        kinds[e] = (kinds[e] ?? 0) + 1;
      }
      const readmePath = files.find((f) => /read ?me\.md$/i.test(f));
      const readmeRaw = readmePath ? await readIfPresent(readmePath, 400) : '';
      folders.push({
        dir,
        files: files.length,
        kinds,
        notable: files.filter((f) => notablePat.test(f.split('/').pop() ?? '')).slice(0, 8),
        sample: files.length <= 15 ? files.map((f) => f.split('/').pop() ?? f) : [],
        readme: readmeRaw.replace(/\s+/g, ' ').trim().slice(0, 400),
      });
    }

    const packages: PackageMap[] = [];
    const pkgDirs = new Set(['', ...facts.rnRoots]);
    for (const p of all.filter((x) => x.endsWith('/package.json') && !x.includes('node_modules')).slice(0, 12)) {
      pkgDirs.add(p.slice(0, -'/package.json'.length));
    }
    for (const dir of [...pkgDirs].slice(0, 12)) {
      const raw = await readIfPresent(dir ? `${dir}/package.json` : 'package.json', 4000);
      if (!raw) continue;
      try {
        const pkg = JSON.parse(raw) as { name?: string; description?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const dirFiles = byDir.get(dir || '(root)') ?? [];
        packages.push({
          dir: dir || '(root)',
          name: pkg.name ?? dir,
          description: (pkg.description ?? '').slice(0, 200),
          scripts: Object.keys(pkg.scripts ?? {}).slice(0, 12),
          depCount: Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).length,
          hasReadme: dirFiles.some((f) => /read ?me/i.test(f)),
          hasTests: dirFiles.some((f) => /(__tests__|__mocks__|\.test\.|\.spec\.|e2e)/i.test(f)),
        });
      } catch {
        // skip unparseable manifests
      }
    }

    const entryPoints = all
      .filter((p) => /(^|\/)(index\.(ts|js|tsx|jsx)|main\.(ts|js)|app\.(ts|tsx|js)|_layout\.tsx|server\.(ts|js)|cli\.(ts|js))$/i.test(p))
      .slice(0, 15);
    const docFiles = all.filter((p) => /\.md$/i.test(p) && !p.includes('node_modules')).slice(0, 20);
    // Doc digest: READMEs + root project docs, the fastest route to "what is this".
    const docPicks = [
      ...all.filter((p) => /read ?me\.md$/i.test(p)).slice(0, 4),
      ...['AGENTS.md', 'replit.md', 'task.md', 'plan.md', 'ARCHITECTURE.md', 'OVERVIEW.md'].filter((d) => inTree.has(d)),
    ].slice(0, 7);
    const docs: DocDigest[] = [];
    for (const d of docPicks) {
      const raw = await readIfPresent(d, 1500);
      if (raw) docs.push({ path: d, excerpt: raw.replace(/\s+/g, ' ').trim().slice(0, 1200) });
    }
    return { folders, packages, entryPoints, docFiles, docs };
  },
);

export interface BranchResult {
  branch: string;
  commitSha: string;
  filePath: string;
}

/** Branch + push: always a new branch, never main. */
export const pushPatchToBranch = span(
  { kind: 'TOOL', toolName: 'github_push_patch' },
  async (repoUrl: string, baseBranch: string, branch: string, path: string, content: string, message: string): Promise<BranchResult> => {
    const ctx = parseRepoUrl(repoUrl);
    const octo = getOctokit();
    const { data: base } = await octo.git.getRef({ owner: ctx.owner, repo: ctx.repo, ref: `heads/${baseBranch}` });
    try {
      await octo.git.createRef({ owner: ctx.owner, repo: ctx.repo, ref: `refs/heads/${branch}`, sha: base.object.sha });
    } catch {
      // Branch exists (re-run): reuse it so pushes stay idempotent.
    }
    let sha = '';
    try {
      const { data } = await octo.repos.getContent({ owner: ctx.owner, repo: ctx.repo, path, ref: branch });
      if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
    } catch {
      // New file on this branch.
    }
    const { data: commit } = await octo.repos.createOrUpdateFileContents({
      owner: ctx.owner, repo: ctx.repo, path, message, content: Buffer.from(content, 'utf8').toString('base64'),
      branch, ...(sha ? { sha } : {}),
    });
    return { branch, commitSha: commit.commit.sha ?? '', filePath: path };
  },
);

export interface WatchResult {
  runId: number;
  runUrl: string;
  conclusion: string | null;
  timedOut: boolean;
}

/** Artifacts of a completed run (names only — the verify step matches apk/aab). */
export const listRunArtifacts = span(
  { kind: 'TOOL', toolName: 'github_list_artifacts' },
  async (repoUrl: string, runId: number): Promise<string[]> => {
    const ctx = parseRepoUrl(repoUrl);
    try {
      const { data } = await getOctokit().actions.listWorkflowRunArtifacts({ owner: ctx.owner, repo: ctx.repo, run_id: runId, per_page: 30 });
      return data.artifacts.map((a) => a.name);
    } catch {
      return [];
    }
  },
);

/** Trigger via workflow_dispatch, then poll with backoff to completion. */
export const triggerAndWatch = span(
  { kind: 'TOOL', toolName: 'github_trigger_watch' },
  async (repoUrl: string, workflowFile: string, branch: string, ref: string): Promise<WatchResult> => {
    const ctx = parseRepoUrl(repoUrl);
    const octo = getOctokit();
    const { data: wf } = await octo.actions.listRepoWorkflows({ owner: ctx.owner, repo: ctx.repo, per_page: 50 });
    const fileName = workflowFile.split('/').pop() ?? '';
    const match = wf.workflows.find((w) => w.path === workflowFile || w.path.endsWith('/' + fileName));
    if (!match) throw new Error(`Workflow ${workflowFile} not registered.`);
    await octo.actions.createWorkflowDispatch({ owner: ctx.owner, repo: ctx.repo, workflow_id: match.id, ref });
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 20000));
      const { data } = await octo.actions.listWorkflowRuns({
        owner: ctx.owner, repo: ctx.repo, workflow_id: match.id, branch, per_page: 3,
      });
      const latest = data.workflow_runs[0];
      if (latest && latest.status === 'completed') {
        return { runId: latest.id, runUrl: latest.html_url, conclusion: latest.conclusion, timedOut: false };
      }
      if (Date.now() > deadline) {
        return { runId: latest?.id ?? 0, runUrl: latest?.html_url ?? '', conclusion: latest?.conclusion ?? null, timedOut: true };
      }
    }
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
