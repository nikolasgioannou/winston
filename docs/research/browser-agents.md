# Research: browser-agent approaches (state of the art)

> Researched 2026-09-26. Many leaderboard numbers come from aggregators (mainly leaderboard.steel.dev) and mix self-reported and verified results. Read them as directional.

## Summary recommendation

**Hybrid with a code escape hatch, on real headful Chrome over direct CDP.** Winston owns the agent loop and uses the browser as a set of tools, rather than handing control to a self-contained agent framework. Refs drive the actions. Screenshots are used to verify and as a fallback. The agent can run JS/Python when it needs to. It learns per-site skills and replays recurring flows.

## Interaction paradigms

| Paradigm                         | Strengths                                     | Weaknesses                                           | Examples                                                                                                                        |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Screenshot + coordinates         | Works on any UI (canvas, iframes, shadow DOM) | Slowest, 3–10x cost per step, clicks less precise    | GPT-5.4 (92.8% Online-Mind2Web, screenshots only), Gemini 3.5 Flash built-in computer use (Jun 2026), Claude                    |
| Accessibility tree / refs        | Cheapest, fastest, most precise               | Blind to visual-only state and poorly labelled sites | Playwright MCP/CLI, Vercel agent-browser (`snapshot -i` ≈ 200–400 tokens vs ≈13.7k for a full Playwright MCP dump)              |
| **Hybrid (refs + screenshot)**   | The 2026 production default                   | More tools to build                                  | "Deterministic skeletons with vision fallbacks"                                                                                 |
| act/extract/observe              | Action caching, replay without an LLM         | Framework lock-in                                    | Stagehand v3 (direct CDP, auto-caching)                                                                                         |
| Agent writes CDP/Playwright code | Biggest recent gains                          | Needs a sandbox                                      | Browser Use's 97% (code for extraction was the biggest single gain), browser-harness (raw CDP + self-written per-domain skills) |

## Frameworks (as of Sep 2026)

- **Browser Use** (Python, MIT, direct CDP): most-cited open-source agent. Online-Mind2Web 97% (judged by its own custom agentic judge). Can attach to any CDP endpoint.
- **Stagehand v3/v4** (TypeScript, Browserbase): most mature for production, with action caching. Accepts `cdpUrl`.
- **Skyvern**: vision-first. Turns a successful run into code and replays it. Web Bench 64.4% (the harder benchmark, including write actions).
- **Playwright MCP / CLI**: broad tool coverage. The CLI is about 4x cheaper in tokens.
- **Vercel agent-browser**: the token-efficiency leader.
- **Agent Browser Protocol (ABP)**: Chromium fork that freezes JS and time between steps. 90.53% Online-Mind2Web with Opus 4.6.
- Magnitude (vision-first TS), Nanobrowser and Agent-E are second tier or stale.
- 2026 consensus: runtime choice and safety boundaries matter more than which framework you pick.

## Benchmarks (as of Sep 2026)

- **Online-Mind2Web** (live sites, most relevant to Winston): Browser Use Cloud 97% · GPT-5.4 computer use ~93% · ABP + Opus 4.6 90.5% · TinyFish 90% · UI-TARS-2 88.2% · Operator 61.3% (Apr 2025).
- **OSWorld-Verified** (full desktop): Qwen3.8-Max 86.1% (self-reported) · Claude Mythos Preview 85.4% · Claude Fable 5 85.0% · Opus 4.8 83.4% · **Sonnet 5 81.2%** · GPT-5.4 75.0% · human baseline ≈72%.
- **WebVoyager** (saturated): shell-native CDP harness + Fable 5 99.19%.
- **WebArena**: 74.3% (DeepSeek v3.2), about 4 points below human performance.
- **BrowseComp** (research-style browsing): GPT-5.6 Sol Ultra 92.2% · GPT-6 Astra 91.5% · Kimi K3 91.2% · Claude Opus 5 90.8%.
- Reality check: hard live write-tasks are far lower (Web Bench best is 64.4%; some studies find about 30%).

## What separates great agents from mediocre ones

1. **Replay learned workflows.** Cache successful runs as code or action lists, replay them deterministically, and fall back to the LLM when a replay breaks. Keep per-domain skill files. Curated, per-site, offline-distilled memory beats dumping raw memory into context (Jun 2026 study).
2. **Code escape hatch.** JS/Python for extraction and bulk work.
3. **Self-verification.** Re-check state (screenshot + DOM) after every committing action, and run a verifier before reporting success.
4. **Page stability.** Wait for the page to settle, and dismiss popups and cookie banners deterministically.
5. **Planner/actor split.** Cheap models for easy steps, the frontier model for hard decisions.
6. **Anti-bot.** A real, logged-in, headful Chrome beats any stealth patch. Use direct CDP rather than Playwright's patched driver. **Avoid leaving `Runtime.enable` on**, because page scripts can detect it.
7. **Prompt-injection defence.** Treat page text as untrusted. Anthropic reports 0.93–3.7% attack success for the model alone, and 0% with mitigations (Jul 2026).
8. **Token hygiene.** Compact ref snapshots, screenshots only when needed, and old observations trimmed from history.

## Proposed Winston browser tool surface

1. `snapshot`: compact interactive-element list with refs.
2. `click` / `type` / `select` (ref).
3. `screenshot`: downscaled, on demand and after every committing action.
4. `click_xy` / `scroll`: coordinate fallback.
5. `eval_js` + a Python extraction sandbox (on the VM): the escape hatch.
6. `handoff_to_human(reason)`: returns the live-view link.

Runtime notes:

- Give each agent its own **window** (not just a tab) to avoid background throttling.
- Serialise risky operations per domain (one agent per site at a time) so agents don't race each other on the shared profile.
- Keep per-site skill files on the VM, which fits "memory is files on his computer".
- Define our own function tools rather than vendor-native computer-use tools. That keeps the stack model-agnostic and OpenRouter-friendly.

## Sources

- https://openai.com/index/introducing-gpt-5-4/
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-computer-use-gemini-3-5-flash/
- https://github.com/vercel-labs/agent-browser · https://paddo.dev/blog/agent-browser-context-efficiency/ · https://testcollab.com/blog/playwright-cli
- https://www.browserbase.com/changelog/stagehand-v3 · https://docs.stagehand.dev/v3/best-practices/caching
- https://browser-use.com/posts/online-mind2web-benchmark · https://github.com/browser-use/browser-harness
- https://www.skyvern.com/docs/developers/features/code-caching · https://github.com/theredsix/agent-browser-protocol
- https://michaellivs.com/blog/state-of-browser-use-2026/ · https://theairuntime.com/p/the-complete-field-guide-to-browser
- https://leaderboard.steel.dev/leaderboards/online-mind2web/ · https://leaderboard.steel.dev/leaderboards/osworld/ · https://leaderboard.steel.dev/leaderboards/browsecomp/
- https://arxiv.org/html/2604.13318v1 · https://arxiv.org/pdf/2606.15017
- https://scrappey.com/qa/anti-bot/what-is-cdp-detection · https://www.anthropic.com/news/prompt-injection-defenses
