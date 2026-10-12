# plan.md — ActionsForge (working name) · team nativeAction · neatHack 2026

An agent that takes a broken or missing GitHub Actions setup for a React Native Android project, fixes it by running the workflow and reading the failures, and ends with a green build, an APK artifact and a PR. Operated from a web page.

All times below are Lagos time (UTC+1). The hackathon runs on IST (UTC+5:30), which is 4.5 hours ahead.

---

## 0. Hard facts (from the hackathon pages)

| Item | Detail |
|---|---|
| Submission window | Mon 12 Oct, 7:00–11:55 PM IST = **14:30–19:25 Lagos** (planned close; **final cutoff is announced on Discord, confirm it**) |
| Time left at writing | About 24h to planned close, about 19h to window opening |
| Submit by | Public quote post on X of the official neatlogs submission post: team, name, project, public repo, demo link, `#neatHack` |
| Demo video | **3 minutes max.** Must explicitly cover neatlogs, Entire and cfo.ai: architecture, implementation, runtime, reasoning, result for each |
| Repo | Public, with commits dated during the hackathon (started Sat 10 Oct, 12:30 PM IST). Evidence lives in the repo |
| Mandatory tools | neatlogs, Entire, cfo.ai. A missing one is a serious gap |
| Model budget | One shared LiteLLM key, **$20** for the whole team (Nova and Claude models), claimed at neatlogs.com/hackathon/models by the team leader (verify check-in email). **That page blocked automated access, so model names and base URL are PENDING: read them in a browser** |
| AWS | $25 allowance, first 350 teams, EC2/Lambda only, no Bedrock. Optional: only needed if we want a hosted demo |
| Team | 1–4 members, one team only |

### Judging weights (this drives every priority below)

| Category | Weight | What wins it |
|---|---|---|
| The agent | 30% | Substantial task, start to finish, with planning, tools, state, recovery, verification, iteration |
| Use of neatlogs, Entire, cfo.ai | 25% | Used to *build and improve* the agent (not bolted on) and to plan the business |
| Demo video | 20% | Clear, covers all three tools, 3 min |
| Building in public | 15% | Real posts on X tagged `#neatHack` while building |
| Usefulness and originality | 10% | Real problem, new angle |

Entire also has a "Best Use of Entire" prize (creative use of Checkpoints, Graph or Brain).

---

## 1. Scope

**In (must ship)**
1. React Native Android: repo in, green `assembleRelease`/`assembleDebug` workflow + uploaded APK artifact + PR out.
2. Web page: paste repo URL and goal, watch a live timeline (plan, patch, push, run status, failure diagnosis, retry), final report.
3. Failure recovery loop with an iteration cap and a verification step.
4. A failure playbook (known RN Android CI failures) tried before open-ended LLM diagnosis.
5. Eval set of broken repos, with a baseline run and an improved run, both traced.

**Stretch (only if everything above is done)**
- Node/Next.js + Vercel/Pages path.
- Hosted demo on AWS.
- Using Entire Graph/Brain on the agent's own codebase.

**Out**
- iOS (needs macOS runners), creating secrets for the user (agent *lists* what's missing), auth/accounts/billing in the product, mobile app.

---

## 2. Architecture (lean)

```
Web page (static HTML + JS, SSE)  <──events──  FastAPI backend
                                                  │
                                         Agent loop (Python)
                          ┌───────────────┬───────┴────────┬───────────────┐
                    GitHub API       Playbook matcher     LLM (LiteLLM,     neatlogs
                  (branch, push,    (regex/rules over     OpenAI-compatible)  (traces for
                   runs, jobs,       log tail)                                 every step)
                   logs, artifacts, PR)
```

**Choices, made to suit a low-spec laptop and a 24h clock**
- Python + FastAPI, plain static page with Server-Sent Events. No Next.js, no build step, no local Android toolchain: all builds run on GitHub's runners.
- LLM via an OpenAI-compatible client pointed at the LiteLLM base URL (PENDING from the models page). The neatlogs guide shows `neatlogs.wrap(OpenAI())`, so this should trace; confirm with the doctor command (section 4).
- GitHub access: a fine-grained token scoped only to the demo/eval repos, with contents, pull requests, actions and **workflows** write permission (pushing workflow files needs it). Token lives in an env var, never in the repo.

**Agent loop**
1. `inspect`: read repo tree, `package.json`, `android/`, existing `.github/workflows/`, lockfiles, Node/JDK hints.
2. `plan`: decide what to generate or patch (LLM, small structured output).
3. `patch`: write/modify workflow files on a new branch (never `main`).
4. `trigger`: push and wait for the run (or dispatch).
5. `watch`: poll run, jobs, steps until complete.
6. `diagnose`: on failure, take the **tail of the failing step's log** (cap lines to save tokens), run playbook matcher, fall back to LLM.
7. `fix`: patch, push, back to 4. **Max 6 iterations and a per-run token budget.**
8. `verify`: conclusion is success **and** the expected APK artifact exists. (A green run with no artifact is a failure; this is a planted case.)
9. `report`: open PR, summarize changes, list manual steps (secrets, signing).

**State**: persist run state (iteration, branch, run IDs, diagnoses) as JSON on disk after every step so a crash can resume.

---

## 3. Eval set (the backbone of the "agent improved" evidence)

One base RN repo, with **one branch per planted failure** (cheap to create, light on the laptop). Aim for 6:

| # | Planted failure | Fails at | Notes |
|---|---|---|---|
| 1 | No workflow at all | n/a | Setup-from-scratch case |
| 2 | Node version too old | install, fast | Good live-demo candidate (fails in about a minute) |
| 3 | Lockfile out of sync, `npm ci` fails | install, fast | Second fast demo case |
| 4 | JDK 11 instead of 17 | Gradle | Slower |
| 5 | `gradlew` not executable | Gradle start | |
| 6 | Green build, wrong artifact path (no APK uploaded) | verify | Proves the verification step |

**Metrics per case**: solved (y/n), iterations to green, wall time, tokens, cost. Take token/latency/cost from neatlogs traces.

**Two versions to compare**
- **Baseline**: LLM-only diagnosis.
- **Improved**: playbook-first + log-tail extraction.

Be honest in the submission: this is a small sample (6 cases), so state the numbers as measured, don't generalize them.

---

## 4. Development workflow

### Tool setup (do first; some steps have lag)

**Entire** (hack.entire.io/neathacks-2026)
- Sign in to entire.io with GitHub. The **GitHub App must be installed on the account/org that owns the repo** (an org admin does this). **Syncing can take up to an hour, so do this before anything else.**
- Install the CLI (the guide shows `brew install --cask entireio/tap/entire` for macOS; for other platforms see docs.entire.io/quickstart).
- In the repo: `entire enable --agent <your coding agent>`. Confirm the exact agent name with `entire enable --help`.
- A checkpoint needs **captured agent session + a Git commit**. Answer **yes** when asked to link a commit to session context.
- Verify: `entire status`, `entire checkpoint list`, `entire checkpoint explain HEAD`.
- Optional: `entire plugin install graph` then `entire graph init-agents --repo .` (commit the three generated files, restart the agent session). Trails are optional and need an access form.
- Note: Entire captures **coding-agent sessions tied to commits**. Our main Entire story is building this project with an Entire-enabled coding agent. A stronger version (stretch): have the product's fixer step run an Entire-enabled coding agent on the target repo so its fix commits are checkpointed too.

**neatlogs** (neatlogs.com/hackathon/neatlogs-setup-guide.html)
- Sign up at app.neatlogs.com, create the project, copy the **Project API key** from Settings → API keys (**not** the `nlw_` HTTP ingest key, which gives a 401). Put it in `NEATLOGS_API_KEY`.
- `pip install neatlogs openai`; `neatlogs.init(api_key=..., workflow_name="actionsforge")`; `client = neatlogs.wrap(OpenAI(base_url=...))`; call `neatlogs.flush()` / `neatlogs.shutdown()` before exit.
- Verify with `python -m neatlogs doctor --probe` (expect `TRACE_VISIBLE` and `TRACE_FINALIZED` PASS).
- Custom spans around GitHub calls, log parsing and playbook matching: **check docs.neatlogs.com/llms.txt for the span API; don't guess it.**
- Time-saver: the setup guide includes a full coding-agent prompt that integrates neatlogs and verifies traces. Run it on our repo once the skeleton exists.
- Reading traces back (for the comparison table): `npm i -g neatlogs-cli`, needs Node 22/24, `neatlogs auth login --device`, then `neatlogs traces list/get --json`.

**cfo.ai** (cfo.ai/neathacks)
- Sign up via the dedicated link. A card is required; **cancel the subscription immediately in Settings → Billing** to avoid being billed. The neatHack team provides credits directly.
- Use it to build the model: pricing, costs, revenue, runway, scenarios. Export it for the submission. Docs: docs.cfo.ai.

**LiteLLM key**: team leader claims it now (limited keys, "while available"). Read model IDs and base URL from the page in a browser.

### Daily rhythm
- **Build log from hour 1.** Save the hackathon build skill (neatlogs.com/hackathon/skill) into the repo's agent instructions. It maintains `hackathon.md` at the repo root: Project, Team, Stack, Build log, Demo, Known limitations, Submission. Update it after each session. No keys, `.env` contents or private traces in it.
- **Small commits, often**, each from an Entire-enabled session, so checkpoints exist for many commits and the commit dates prove in-hackathon work.
- **Trace everything from the first working loop**, not at the end. Failures are evidence too: keep the traces.
- **Branches**: `main` stays demo-able. Work on short feature branches, merge when green.
- **Post on X during the build** with `#neatHack` (see timeline). Screenshots of traces and the live timeline are the content.

---

## 5. Timeline (Lagos time)

| When | Block | Output |
|---|---|---|
| Sun 19:30–20:30 | **Setup** | Repo public, Entire App installed + CLI enabled, neatlogs key + doctor PASS, LiteLLM key claimed, cfo.ai signed up (and cancelled), GitHub token. First X post |
| Sun 20:30–00:30 | **Walking skeleton** | Loop works end to end on case 2 (fast failure): branch, push, watch, diagnose, fix, green. Traced. First Entire checkpoints. Web page shows a basic live timeline |
| Sun 00:30–01:30 | **Eval harness** | Base RN repo + 6 branches; script that runs the agent over all cases and records results |
| Sun ~01:30 | **Baseline run (LLM-only), left running** | Baseline neatlogs traces captured while you sleep |
| Sun ~02:00–07:00 | **Sleep** | |
| Mon 07:00–10:30 | **Improve** | Playbook + log-tail extraction + verify step; fix whatever the baseline showed. Run the improved version over the eval set |
| Mon 10:30–12:30 | **Web page polish** | Clear timeline, diagnosis view, final report, PR link |
| **Mon 12:30** | **Feature freeze** | Only fixes and evidence from here |
| Mon 12:30–14:00 | **Evidence + business plan** | Before/after table from traces, recovery run, Entire checkpoint URL + ID, cfo.ai plan exported, README with setup instructions, `hackathon.md` final |
| Mon 14:00–16:30 | **Demo video** | Record and edit to **under 3:00** |
| Mon 14:30 | Submission window opens | |
| **Mon by ~17:00** | **Submit** | Quote post on X with all links. Leave buffer before 19:25 and check Discord for the final cutoff |

If the schedule slips, cut in this order: hosted deployment, extra eval cases (keep at least 4), Entire Graph, polish. Never cut: baseline vs improved comparison, one recovery trace, Entire checkpoint, cfo.ai plan, demo video.

---

## 6. Demo video script (≤ 3:00)

| Time | Content |
|---|---|
| 0:00–0:20 | Problem: broken Actions / RN Android CI. What the agent does |
| 0:20–1:10 | **Live run** on a fast-failing repo: paste URL, timeline streams, failure, diagnosis, fix, green. (Android case shown as a pre-recorded or cached run, say so) |
| 1:10–1:50 | **neatlogs**: span tree of the recovery loop; before/after table (baseline vs playbook-first) with real numbers |
| 1:50–2:25 | **Entire**: checkpoint for a real commit, session + changes; what it captured and how it helped |
| 2:25–2:50 | **cfo.ai**: pricing, cost per fix, margin, runway scenarios |
| 2:50–3:00 | Result, limits, link |

---

## 7. Evidence checklist (maps to the judging page)

- [ ] **Agent improved**: baseline run and improved run, two neatlogs trace links, with the compared numbers (success, iterations, time, tokens, cost)
- [ ] **Used neatlogs**: trace links or screenshots
- [ ] **Recovers from failure**: a run where a step failed and the next action is visible
- [ ] **Used Entire**: checkpoint URL `https://entire.io/gh/OWNER/REPO/commit/FULL_COMMIT_SHA` **and** checkpoint ID; reviewers must have access (checkpoints in public repos are public); optional `entire graph stats` output
- [ ] **Used cfo.ai**: exported business plan (pricing, costs, revenue, runway) in the repo
- [ ] **Built in public**: X post links, tagged `#neatHack`
- [ ] **Code written during the hackathon**: public repo, commit dates inside the window
- [ ] **Demo video** ≤ 3 min covering all three tools
- [ ] `README` with setup and run instructions; `hackathon.md` complete and sanitized

## 8. Submission checklist (Mon, after 14:30 Lagos)

- [ ] Confirm final cutoff on Discord
- [ ] Re-read neatlogs.com/hackathon for any requirement changes
- [ ] Repo public, no secrets in history (check `git log -p` for keys)
- [ ] Demo link/video public
- [ ] Open the official neatlogs submission post on X, quote it with team (nativeAction), project name, repo, demo
- [ ] Do not close the draft before publishing (opening it alone does not submit)

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Android builds take 5–15 min per iteration | Demo live on fast-fail cases; cache or pre-record the Android run and say so |
| $20 shared model budget | Send only log tails, small structured outputs, per-run token cap; baseline run over 6 cases is the biggest spend, so measure the first case before running all |
| Entire GitHub App sync lag | Install first, verify with `entire status` early |
| Entire is not capturing commits | Test with one tiny commit in the first hour |
| GitHub token cannot push workflow files | Include the Workflows permission when creating the token; test with a trivial workflow push |
| Actions minutes / rate limits | Use public repos; backoff on polling |
| Agent loops forever or burns budget | Iteration cap (6) + token budget + "needs human" exit |
| Judges can't reproduce | README + a recorded run + eval repo links |
| Pre-hackathon code | All code must be written during the event; don't import earlier work |

## 10. Open items

- [ ] LiteLLM base URL and model IDs (page blocked automated access; read in a browser)
- [ ] Which coding agent the team uses (decides the `entire enable --agent` value)
- [ ] Repo owner: personal account or org (who installs the Entire GitHub App)
- [ ] Team members, and who does what (1–4 people)
- [ ] neatlogs span/tool-call API (read docs.neatlogs.com)
- [ ] Final submission cutoff (Discord)





That text is mostly right, and it matches what I read in Entire's guide. Two things are off, and one of its recommendations I'd change.

## What Entire is, and how you use it without Codex

Entire records your **coding agent's sessions** (the prompts and what the agent did) and ties them to your git commits. Code you type by hand shows up as nothing, and so does this chat, because it isn't running in your repo. To have checkpoints, you need a terminal coding agent running in your repo with `entire enable` on.

You don't need Codex specifically. The pasted text lists Claude Code, Codex, Gemini, OpenCode, Cursor, Copilot CLI and Factory Droid. I haven't verified that list, so confirm what your install supports with `entire enable --help`. Pick whichever one you can use cheaply. Gemini CLI and OpenCode are worth checking if you don't have a paid plan.

**Don't spend the shared $20 LiteLLM budget on your coding agent.** That budget is for the product agent at runtime.

Option 1 from the text (build the project with an Entire-enabled coding agent) is the safe way to meet the Entire requirement. Do it for every commit. Option 2 is a bonus.

## Corrections to that text

- **entire-graph is real.** The hackathon's Entire guide documents `entire plugin install graph`, `entire graph init-agents --repo .` and `entire graph stats`. I retracted the "resume after crash" claim earlier, so that part stands. The graph part doesn't need to be dropped.
- **Don't use the Claude Agent SDK as the product agent.** It's a good SDK, but it doesn't fit here:
  - It runs Claude Code underneath, so it burns far more tokens than a simple loop. That's a problem on a shared $20 budget.
  - The hackathon key is an OpenAI-compatible LiteLLM endpoint. I haven't seen whether it speaks the format the Agent SDK needs.
  - neatlogs documents wrapping an OpenAI client. I haven't seen documented support for tracing the Agent SDK's internals, so you risk thin traces on 25% of your score.
  - Your agent's actions are narrow: edit YAML, push, read logs. It doesn't need a general bash tool.

**My recommendation:** write a plain loop that calls the LLM through an OpenAI-compatible client pointed at LiteLLM, with your own tools for the GitHub API. Every step becomes a clean neatlogs span. Use the "planning step before editing" idea from the text as its own span.

For language, use TypeScript if that's what you're fastest in. The neatlogs guide shows a TS SDK, with `init`, `wrapOpenAI` and `shutdown`. That would replace the Python/FastAPI choice in `plan.md`. Everything else in the plan stays the same.

## How to start, in order

It's about 2am and you have about 17 hours to the planned close, so I'd split it:

**Tonight (60–90 min), then sleep:**
1. Create a public GitHub repo. Install the Entire GitHub App on it, because syncing can take up to an hour.
2. Install the Entire CLI, run `entire enable --agent <yours>`, make one tiny commit through your coding agent, and confirm it with `entire status` and `entire checkpoint list`. If this doesn't work, you need to know now.
3. Create the neatlogs project and put the **Project API key** (not the `nlw_` one) in `NEATLOGS_API_KEY`. Make one traced "hello" LLM call and see it in the dashboard.
4. Claim the LiteLLM key and note the base URL and model names.
5. Make the first X post with `#neatHack`.

**Tomorrow from about 07:00:**
1. Build the loop skeleton on the fast-failing case. Trace every step.
2. Build the web page.
3. Build the eval set and the playbook.
4. Do the cfo.ai plan after the product works.

With the overnight baseline run dropped, the plan's freeze at 12:30 gets tight. Keep the baseline-versus-improved comparison anyway. It's what proves "the agent improved" for the judges.

I can write the repo scaffold next (folder layout, the loop's types, the GitHub tool functions and the neatlogs wiring) so your coding agent has something concrete to extend. Which language do you want it in?