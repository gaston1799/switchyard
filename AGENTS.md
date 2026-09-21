# AGENTS.md

## Project

This repository contains Switchyard, a Node.js coding-agent harness for DeepSeek, GLM, Claude, and GPT with workspace tools, session memory, detached execution, and native Codex/Claude Code connections. The legacy npm identifier and data paths remain compatible.

## Working Rules

- Keep the package dependency-light. Prefer built-in Node APIs unless a dependency is clearly justified.
- Preserve the OpenAI-compatible chat/tool-call shape.
- Keep tool implementations in `src/deepseek-watch.js` unless the feature becomes large enough to split cleanly.
- Run `npm run check` after JavaScript edits.
- Update `README.md` and `prompts/default-system.md` when adding or changing model-visible tools.
- Do not remove or rewrite user-created files such as `requests.md` unless explicitly asked.

## Tool Direction

The wrapper should move toward Codex-style namespaced tools:

- `functions_shell_command`
- `functions.update_plan`
- `functions.create_goal`
- `functions.get_goal`
- `functions.update_goal`
- `functions.read_text_file`
- `functions.write_text_file`
- `functions.patch_text_file`
- `functions.web_search`

Current implementation still includes legacy flat names such as `run_cmd`, `run_powershell`, `read_text_file`, and `web_search`. New work should prefer compatibility aliases rather than breaking existing prompts.

## Long-Running Agent Goals

For detached or long-running runs, persist useful state in the session JSON:

- Active goal objective and status.
- Plan steps with `pending`, `in_progress`, and `completed` states.
- Tool results needed to resume safely.
- Files touched by edit tools.

Delegated LLM handoffs should use a fresh output file and log file for each run, then Codex should verify the diff and checks locally.
