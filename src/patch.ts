import { span } from 'neatlogs';
import { config } from './config.js';
import { getTracedLlmClient } from './llm.js';

export interface WorkflowPatch {
  path: string;
  summary: string;
  newContent: string;
  changed: boolean;
  attempts: number;
  verified: boolean;
  verifyNotes: string[];
}

const MAX_PATCH_ATTEMPTS = 3;

/** Exact, free text transforms for the known playbook findings. Returns content + labels. */
function deterministicTransforms(current: string, fix: string, nodeEngines: string): { content: string; applied: string[] } {
  let out = current;
  const applied: string[] = [];
  if (/jdk|java-version/i.test(fix) && /java-version:\s*['"]?(?!17\b)[^'"\s]+/i.test(out)) {
    out = out.replace(/java-version:\s*['"]?[^'"\s]+['"]?/i, "java-version: '17'");
    applied.push('java-version->17');
  }
  if (/node-version|node\.?js version/i.test(fix)) {
    const major = nodeEngines.match(/\d+/)?.[0];
    if (major && new RegExp(`node-version:\\s*['"]?(?!${major}\\b)[^'"\\s]+`, 'i').test(out)) {
      out = out.replace(/node-version:\s*['"]?[^'"\s]+['"]?/i, `node-version: '${major}'`);
      applied.push(`node-version->${major}`);
    }
  }
  if (/chmod|gradlew.*permission|permission.*gradlew/i.test(fix)) {
    const lines = out.split('\n');
    const gi = lines.findIndex((l) => /gradlew\s+(assemble|bundle|test|connected)/i.test(l));
    if (gi >= 0 && !lines.slice(0, gi).some((l) => /chmod\s+\+x.*gradlew/i.test(l))) {
      let si = gi;
      while (si > 0 && !/^\s*-\s/.test(lines[si])) si--;
      const ind = lines[si].match(/^(\s*)-/)?.[1] ?? '      ';
      const gradlewPath = lines[gi].match(/(\S*gradlew)/)?.[1] ?? 'android/gradlew';
      lines.splice(si, 0, `${ind}- name: Make gradlew executable`, `${ind}  run: chmod +x ${gradlewPath}`);
      out = lines.join('\n');
      applied.push('chmod-step');
    }
  }
  if (/artifact|upload/i.test(fix)) {
    const lines = out.split('\n');
    if (!lines.some((l) => /upload-artifact/i.test(l))) {
      const gi = lines.findIndex((l) => /gradlew\s+(assemble|bundle)/i.test(l));
      if (gi >= 0) {
        let si = gi;
        while (si > 0 && !/^\s*-\s/.test(lines[si])) si--;
        const ind = lines[si].match(/^(\s*)-/)?.[1] ?? '      ';
        let end = si + 1;
        while (end < lines.length && lines[end].trim() !== '' && !/^\s*-\s/.test(lines[end])) end++;
        lines.splice(end, 0, `${ind}- name: Upload APK`, `${ind}  uses: actions/upload-artifact@v4`, `${ind}  with:`, `${ind}    name: app-release`, `${ind}    path: android/app/build/outputs/apk/release/*.apk`);
        out = lines.join('\n');
        applied.push('upload-artifact-step');
      }
    }
  }
  return { content: out, applied };
}

function extractBody(text: string): string {
  let body = text.match(/---FILE---([\s\S]*?)---END---/)?.[1]?.trim() ?? '';
  if (!body) {
    const fences = [...text.matchAll(/```(?:ya?ml)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
    body = fences.sort((a, b) => b.length - a.length)[0] ?? '';
  }
  return body.replace(/^```(?:ya?ml)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function structuralCheck(
  parse: (s: string) => any,
  current: string,
  body: string,
): { ok: boolean; reason: string } {
  let next: any;
  try {
    next = parse(body);
  } catch (e) {
    return { ok: false, reason: `not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
  }
  if (!next || typeof next !== 'object' || !next.jobs || !next.on) {
    return { ok: false, reason: 'drops required top-level keys (need on: and jobs:)' };
  }
  let prev: any;
  try {
    prev = parse(current);
  } catch {
    return { ok: false, reason: 'current file itself does not parse (cannot diff safely)' };
  }
  if (JSON.stringify(Object.keys(next.jobs)) !== JSON.stringify(Object.keys(prev?.jobs ?? {}))) {
    return { ok: false, reason: `renames/removes jobs (was [${Object.keys(prev?.jobs ?? {}).join(',')}])` };
  }
  return { ok: true, reason: '' };
}

/** Re-check the patched file against the mechanical rules (no LLM needed). */
export function verifyPatchContent(parse: (s: string) => any, body: string, fix: string): { verified: boolean; notes: string[] } {
  const notes: string[] = [];
  let doc: any;
  try {
    doc = parse(body);
  } catch {
    return { verified: false, notes: ['re-parse failed'] };
  }
  const steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> = Object.values(doc.jobs ?? {}).flatMap((j: any) =>
    Array.isArray(j?.steps) ? j.steps : [],
  );
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (/jdk|java-version|java 21/i.test(fix)) {
    const pins = steps.filter((s) => /setup-java/i.test(text(s.uses))).map((s) => String(s.with?.['java-version'] ?? ''));
    notes.push(pins.length && pins.every((p) => /17/.test(p)) ? `java pinned to ${pins.join(',')}` : `java pins now [${pins.join(',') || 'none'}] — expected 17`);
  }
  if (/chmod/i.test(fix)) {
    const idx = (re: RegExp): number => steps.findIndex((s) => re.test(text(s.run)));
    const c = idx(/chmod\s+\+x.*gradlew/i);
    const g = idx(/gradlew\s+(assemble|bundle|test|connected)/i);
    notes.push(c >= 0 && (g < 0 || c < g) ? 'chmod +x present before gradle' : 'chmod ordering still wrong/missing');
  }
  if (/artifact|upload/i.test(fix)) {
    notes.push(steps.some((s) => /upload-artifact/i.test(text(s.uses))) ? 'upload-artifact present' : 'still no upload-artifact step');
  }
  if (/trigger|push/i.test(fix)) {
    const on = doc.on;
    const trig = typeof on === 'string' ? on : Array.isArray(on) ? on.join(',') : on ? Object.keys(on).join(',') : '';
    notes.push(/push/.test(trig) ? `triggers [${trig}] cover push` : `triggers [${trig}] still lack push`);
  }
  const bad = notes.filter((n) => /still|expected|wrong|missing/i.test(n));
  return { verified: bad.length === 0, notes };
}

/**
 * Generates the patched workflow file with a self-retry loop: each failed
 * validation (bad YAML, dropped keys, renamed jobs) is fed back into the
 * next attempt along with the model's own previous output, up to
 * MAX_PATCH_ATTEMPTS. A patch that passes is re-verified against the
 * mechanical rules before it is returned.
 */
export const generateWorkflowPatch = span(
  { kind: 'AGENT', name: 'generate_patch' },
  async (input: { path: string; current: string; diagnosis: string; fix: string; nodeEngines: string }): Promise<WorkflowPatch> => {
    const { parse } = await import('yaml');
    // Deterministic first: exact transforms for known findings (free, exact).
    const det = deterministicTransforms(input.current, `${input.diagnosis}\n${input.fix}`, input.nodeEngines);
    if (det.applied.length) {
      const check = structuralCheck(parse, input.current, det.content);
      if (check.ok) {
        const v = verifyPatchContent(parse, det.content, input.fix);
        if (v.verified) {
          return { path: input.path, summary: `deterministic: ${det.applied.join(', ')}`, newContent: det.content, changed: true, attempts: 1, verified: true, verifyNotes: v.notes };
        }
      }
    }
    const client = getTracedLlmClient();
    const base = `You patch a GitHub Actions workflow minimally. Rules: change ONLY what the diagnosis requires; preserve every other step, pin and trigger exactly; output valid YAML only inside the markers; keep the same top-level keys (on, jobs); keep 2-space indentation, no tabs, no prose inside the file block.\n\nDiagnosis: ${input.diagnosis}\nRequired fix: ${input.fix}\n\nCurrent ${input.path}:\n${input.current.slice(0, 10000)}\n\nReply exactly:\nSUMMARY: <one line>\n---FILE---\n<full new file content>\n---END---`;
    let previous = '';
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
      const prompt =
        attempt === 1
          ? base
          : (() => {
              const lineNo = lastError.match(/line (\d+)/)?.[1];
              const excerpt = lineNo
                ? previous.split('\n').slice(Math.max(0, Number(lineNo) - 6), Number(lineNo) + 5).map((l, i) => `${Number(lineNo) - 5 + i}: ${l}`).join('\n')
                : previous.slice(0, 2000);
              return `${base}\n\nYour previous output FAILED validation with: ${lastError}\nOffending region:\n${excerpt}\n\nFix ONLY the validation problem, keep everything else identical, and output the full file again in the same format.`;
            })();
      const res = await client.chat.completions.create({
        model: config.litellmModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
      });
      const text = res.choices[0]?.message?.content?.trim() ?? '';
      const summary = text.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() ?? 'workflow patch';
      const body = extractBody(text);
      previous = body || text;
      if (!body || body === input.current.trim()) {
        lastError = 'empty output or byte-identical to current file';
        continue;
      }
      const check = structuralCheck(parse, input.current, body);
      if (!check.ok) {
        lastError = check.reason;
        continue;
      }
      const v = verifyPatchContent(parse, body, input.fix);
      return { path: input.path, summary: `${summary} (attempt ${attempt}/${MAX_PATCH_ATTEMPTS})`, newContent: body, changed: true, attempts: attempt, verified: v.verified, verifyNotes: v.notes };
    }
    return {
      path: input.path,
      summary: `Rejected after ${MAX_PATCH_ATTEMPTS} attempts (last: ${lastError || 'no output'})`,
      newContent: input.current,
      changed: false,
      attempts: MAX_PATCH_ATTEMPTS,
      verified: false,
      verifyNotes: [],
    };
  },
);
