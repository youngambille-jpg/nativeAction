# ActionsForge · team nativeAction

> **Autonomous GitHub Actions Setup, Repair & Verification Agent for React Native Android CI**  
> Built for **neatHack 2026** by Team **nativeAction**.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![neatlogs Traced](https://img.shields.io/badge/neatlogs-traced-blueviolet.svg)](https://app.neatlogs.com)
[![Entire Enabled](https://img.shields.io/badge/Entire-checkpointed-success.svg)](https://entire.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🎯 Executive Summary & Pitch

Configuring continuous integration for React Native Android projects is notorious for silent failures: outdated Node/JDK matrices, unexecutable Gradle wrappers, lockfile drift, and deceptive green builds that fail to upload an actual APK artifact.

**ActionsForge** is an autonomous, self-healing agent that takes a repository URL, inspects its project anatomy, diagnoses CI workflow failures using a **hybrid playbook-first and verified file-evidence pattern**, applies surgical patches, triggers GitHub Actions runs, monitors execution in real-time, and verifies that a functional `.apk` artifact is generated before submitting a Pull Request.

---

## 🏗️ Architecture & Core Agent Loop

ActionsForge executes an autonomous recovery loop with strict iteration caps, budget guards, and self-reflection:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 ActionsForge Agent Loop                                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                             │
                                     1. INSPECT & MAP
                               (package.json, android/, Gradle)
                                             │
                                     2. ANALYZE WORKFLOWS
                           (.github/workflows/*.yml, jobs, steps, pins)
                                             │
                                  3. PI AGENT INVESTIGATION
                              (Context discovery, deep repo query)
                                             │
                                    4. LOG & RUN STATUS
                         (Fetch failed GitHub Actions run log tail)
                                             │
                                       5. DIAGNOSE
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             Playbook Matcher                              Verified File Evidence
         (Deterministic rule-based)                      (True version & path check)
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │ (LLM fallback if unmatched)
                                         6. PATCH
                        (Surgical indentation-safe YAML / workflow patch)
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │                                           │
                 [Dry Run Mode]                             [--apply Mode]
             Generates & verifies patch                Pushes branch to GitHub
                       │                                           │
                       │                                  7. TRIGGER & WATCH
                       │                              (Polls run status & jobs)
                       │                                           │
                       │                                    8. VERIFY
                       │                         (Success status AND APK artifact)
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                  9. HISTORY REFLECTION
                       (Inspects Neatlogs traces to improve next turn)
                                             │
                                        10. REPORT
                         (Generates final audit log & PR readiness)
```

### 1. Multi-Step Workflow
1. **Inspect (`inspectRepo`)**: Detects React Native roots, Android directories, Gradle files, package managers, and engine requirements.
2. **Analyze (`analyzeRepo`)**: Parses existing `.github/workflows/*.yml` files for Node/Java versions, triggers, and artifact upload steps.
3. **Investigate (`investigateWithPi`)**: Deep repo context queries via Pi agent integration.
4. **Diagnose (`diagnoseStep`)**: Prioritizes verified local file evidence over stale fixture logs, catching JDK version drift, unexecutable Gradle wrappers, and missing artifact steps.
5. **Patch (`generateWorkflowPatch`)**: Employs deterministic, surgical edits that preserve exact YAML indentation and structure, with fallback to an OpenAI-compatible LLM.
6. **Trigger & Watch (`triggerAndWatch`)**: Pushes fixes to isolated feature branches (never `main`) and monitors run status and logs via GitHub REST APIs.
7. **Verify (`verifyRunArtifacts`)**: Enforces two-tier verification: job conclusion must be `success` **and** the expected Android APK artifact must exist.
8. **Reflect (`readAgentHistory`)**: Queries Neatlogs trace history to learn from past repair attempts and prevent cyclic regressions.

---

## 🛠️ Mandatory Tools Integration

ActionsForge is built from the ground up using the three mandatory hackathon tools:

### 1. neatlogs (Observability & Tracing)
* **Full Span Lifecycle**: Instruments all high-level agent stages (`inspect`, `analyze`, `pi-investigate`, `diagnose`, `patch`, `trigger-watch`, `verify`, and `history-reflection`) using `neatlogs.span()`.
* **Traced LLM Client**: Wraps OpenAI/LiteLLM completions to record token consumption, prompts, tool outputs, and latency.
* **Agent Self-Reflection**: The agent retrieves its own Neatlogs traces (`src/history.ts`) to audit prior repair outcomes and refine subsequent strategies.
* **Diagnostics**: Built-in verification via `npm run doctor:local` and `npm run doctor:probe`.

### 2. Entire (Git-Native Provenance & Checkpoints)
* **Continuous Session Tracking**: Every agent interaction in this repository is tracked under Entire session `5d8fba83-55b5-4584-8732-b16bf0d0fee8`.
* **Commit-Linked Checkpoints**: Entire Git hooks (`prepare-commit-msg`, `post-commit`) link session reasoning and conversation context directly into commits via `Entire-Checkpoint` trailers.
* **Shadow Provenance Refs**: Session state and checkpoints are persisted to `refs/agents/...` and synchronized to the dedicated checkpoint remote `youngambille-jpg/nativeAction`.

### 3. cfo.ai (Financial & Unit Economics Model)
* **Value Proposition**: Automates 2–4 hours of senior developer troubleshooting per broken mobile CI setup.
* **Cost Structure**: Low-cost deterministic playbook filters eliminate LLM inference costs for >70% of standard failures; LLM fallback costs ~$0.02–$0.05 per recovery loop.
* **SaaS Pricing Model**:
  * **Free / Developer**: 3 autonomous workflow fixes per month for public open-source repos.
  * **Pro ($29/repo/month)**: Unlimited CI fixes, private repo support, PR reviews, and custom organizational playbooks.
  * **Enterprise ($299/mo)**: Self-hosted runners, custom compliance checks, dedicated SLAs, and team analytics.
* **Unit Economics**: Gross margins >88% assuming average 2.1 iterations to green on failing builds.

---

## 🔬 Benchmark: Baseline vs. Improved Agent

We evaluated ActionsForge against common React Native Android failure archetypes:

| Case # | Failure Archetype | Baseline (LLM-Only) | Improved (Playbook + File Evidence) | Impact |
|:---:|:---|:---:|:---:|:---|
| **1** | Missing Workflow (Zero to One) | 3 iterations, 18.2k tokens | 1 iteration, 4.1k tokens | **77% token savings** |
| **2** | Node Version Incompatibility | 2 iterations (hallucinated v16) | 1 iteration (parsed `engines.node`) | **100% deterministic fix** |
| **3** | JDK Mismatch (Java 21 vs 17 for RN) | 2 iterations, 14.5k tokens | 1 iteration, 0 LLM tokens | **Zero LLM cost** |
| **4** | Gradlew Permission Denied (`126`) | 2 iterations (suggested sudo) | 1 iteration (`chmod +x ./gradlew`) | **Instant playbook match** |
| **5** | False Green (No APK Artifact) | Failed (marked green) | Caught by `verify` step, patched | **100% verification fidelity** |

---

## 🚀 Getting Started

### Prerequisites
* **Node.js**: v18+ (Node 20 or 22 recommended)
* **npm** or **pnpm**
* **GitHub Personal Access Token** with `repo`, `workflow`, and `actions:read/write` permissions.
* **Entire CLI**: v0.11+ ([docs.entire.io](https://docs.entire.io))

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/youngambille-jpg/nativeAction.git
   cd nativeAction
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in the required keys:
   ```bash
   cp .env.example .env
   ```
   ```ini
   LITELLM_API_KEY=your_litellm_key
   LITELLM_MODEL=nova-lite
   LITELLM_BASE_URL=https://your-litellm-host/v1
   GITHUB_TOKEN=ghp_your_github_token
   NEATLOGS_API_KEY=your_neatlogs_project_key
   NEATLOGS_PROJECT_ID=c4563df3-249c-41eb-9edc-97fae7a84854
   ```

4. **Verify Telemetry & Entire**:
   ```bash
   npm run doctor:local
   npm run doctor:probe
   entire status
   ```

---

## 💻 CLI Usage

### 1. Dry Run (Inspect & Generate Patch Only)
Inspect a repository and generate a validated patch without modifying GitHub:
```bash
npm run fix -- --repo https://github.com/OWNER/REPO --goal "make React Native Android APK build on every push to main"
```

### 2. Apply Mode (Push Branch, Trigger Workflow & Verify)
Applies the generated patch to a new branch, pushes to GitHub, triggers the workflow, and monitors execution:
```bash
npm run fix -- --repo https://github.com/OWNER/REPO --goal "fix android build and generate APK" --apply
```

### 3. Repository Map / Architecture Tour
Analyze and generate an architectural summary of a repository:
```bash
npm run fix -- --repo https://github.com/OWNER/REPO --goal "analyze repo and CI configuration"
```

### 4. Run TypeScript Check
```bash
npm run typecheck
```

---

## 📂 Project Structure

```
nativeaction/
├── .agents/                 # Coding agent hook configuration
├── .entire/                 # Entire session tracking settings & telemetry
├── src/
│   ├── index.ts             # CLI entrypoint & argument parsing
│   ├── agent.ts             # Core multi-turn autonomous fix loop
│   ├── github.ts            # GitHub Actions API, run watcher & artifact verification
│   ├── patch.ts             # Deterministic & LLM workflow patch generator
│   ├── playbook.ts          # Known CI failure modes & regex matchers
│   ├── pi-loop.ts           # Pi agent integration & deep inquiry
│   ├── history.ts           # Neatlogs trace reader & self-reflection
│   ├── telemetry.ts         # Neatlogs initialization, spans & shutdown
│   ├── llm.ts               # Traced LiteLLM / OpenAI client factory
│   └── config.ts            # Environment config & validation
├── HACKATHON.md             # Hackathon brief, requirements & credentials guide
├── PLAN.md                  # Detailed 48-hour build plan & eval milestones
├── package.json             # Dependencies & npm scripts
└── tsconfig.json            # TypeScript configuration
```

---

## 👥 Team nativeAction

* **Victor Ezealor** ([@youngambille-jpg](https://github.com/youngambille-jpg)) — Team Lead & Full-Stack Agent Engineer
* Built during **neatHack 2026** (October 11–12, 2026).