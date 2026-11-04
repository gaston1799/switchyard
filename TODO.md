# DeepSeek Watch TODO

## Multi-agent coordination

- [x] Give every running wrapper a stable agent ID, role, mission, heartbeat, and discoverable runtime record.
- [x] Support durable agent-to-agent messages, task claims, handoffs, and parked `agent_wait` wake/resume behavior.
- [ ] Allow the operator to queue a message from the same TUI while the current agent is parked in `agent_wait`.
  - Keep the terminal input prompt active while the wrapper is in `waiting_for_message`; typing a normal line and pressing Enter must enqueue a durable message from `operator` to the current `agent_id`.
  - Wake and resume the same saved session through the existing coordination inbox path, preserving message IDs and acknowledgement semantics instead of inserting directly into model history.
  - Display a compact parked-state prompt with the agent ID, wait reason, and timeout; do not leave an API/model request active while waiting for operator input.
  - Continue accepting messages from other agents while the operator prompt is visible. Resolve simultaneous operator/agent messages without dropping, duplicating, or reordering already-queued messages.
  - Preserve non-interactive/headless behavior: `--no-output`, redirected stdin, and detached sessions must continue waiting only on the coordination inbox or configured timeout.
  - Define parked commands for at least `/agents`, `/tasks`, and `/exit`; commands must not be forwarded to the model as ordinary text.
  - Add an end-to-end regression test that parks a mock-model session, writes a line to TUI stdin, confirms the same session resumes with a tagged operator message, writes its final outfile, and leaves no message unacknowledged.
- [ ] Add an in-TUI agent manager so an operator can create and supervise a coordinator and workers without opening commands manually.
  - Provide actions to add, start, message, wake, park, stop, and resume agents; require agent ID, role, mission, permission level, workspace, and shared coordination directory before launch.
  - Show live agent ID, role, PID, heartbeat/state, mission, claimed task, wait reason, worktree, and pending-message count from the existing coordination records.
  - Allow the coordinator prompt and bounded worker prompts to be edited before launch, with safe defaults that tell workers to announce themselves, claim only assigned work, hand off results, and park afterward.
  - Support an optional separate Git worktree per writing agent and clearly warn before launching multiple writers in one working tree.
  - Reuse the existing CLI/session/coordination implementation rather than creating a second messaging or process registry in the TUI.
  - Add integration coverage for creating two mock workers, discovering them, assigning separate tasks, sending messages, parking/waking, and stopping them cleanly.
- [ ] Set the terminal/window title to the current agent identity once registration completes.
  - Use a compact title such as `dsw · coordinator · MyServer` or `dsw · worker-1 · MyServer`; the stable `agent_id` takes precedence over a generic role label.
  - Refresh the title when a generated ID is assigned, a saved session is resumed, or the TUI switches between managed agents.
  - Preserve the existing workspace-only title when coordination is unavailable, and avoid emitting title-control sequences in `--no-output`, non-TTY, or redirected sessions.
  - Add a renderer/CLI regression test covering coordinator, worker, resumed-session, and non-TTY title behavior.

## Deferred integrations

- [ ] Add Slack mobile messaging through the official Switchyard app and a local connector.
  - [x] Create the branded owner address `switchyard@agent-toolpacks.com`, register the Switchyard Slack app, install it in the Agent Toolpacks development workspace, and add the Switchyard icon.
  - See [Slack setup and manifest](integrations/slack/README.md) for the registered app and current setup status.
  - Keep agents running on each user's computer. Model requests must use that user's configured provider credentials or supported signed-in backend; the shared relay must not supply or share the developer's model credits.
  - Build a Cloudflare-hosted messaging relay with Slack signature verification, OAuth state validation, isolated workspace credentials, and an authenticated outbound connection from each paired Switchyard installation.
  - Provide a Connect Slack / Add to Slack flow for GitHub installations, authorize the intended Slack users, and support revoking a paired computer. Offer a self-hosted relay / bring-your-own Slack app option later.
  - Map Slack workspace, channel, and thread to a project, session, and agent. Persist message IDs and queued/received/failed receipts so retries and reconnects do not duplicate work or cross project boundaries.
  - Wake parked agents, queue messages for working agents at safe turn boundaries, and resume stopped sessions once using their saved working and coordination directories.
  - Return agent replies to the originating Slack thread. Add a dedicated messaging skill for concise progress, questions, completion, and parking while awaiting a reply without idle model requests.
  - Verify phone-to-agent-to-phone delivery, attachments, reconnect recovery, isolation between two users/workspaces, and credential/billing separation before enabling customer distribution.
  - Keep relay hosting costs separate from model usage. Defer production deployment and Slack Marketplace publication until the connector and end-to-end flow are ready.

- [ ] Add a generic `mcp_call` client surface.
  - No MCP server or connection details are currently configured.
  - Keep the implementation transport-agnostic: stdio and HTTP, explicit per-server configuration, and least-privilege tool exposure.
  - Do not infer credentials or install third-party MCP servers automatically.

## DeepSeek skills system (Codex-style skills for dsw)

- [x] Design and implement a DeepSeek-native skills storage/discovery format, mirroring how Codex stores skills.
  - Codex uses `~/.codex/skills/<name>/SKILL.md` with `name` + `description` frontmatter and an injected skills index per prompt. The DeepSeek version should have its own root (e.g. `~/.deepseek/skills/` or `~/.deepseek-agent-watch/skills/`) with the same SKILL.md convention so it is discoverable no matter the working directory.
  - Decide compatibility: keep reading `~/.codex/skills` and workspace `.deepseek-watch/skills` as fallback sources, but make the DeepSeek root canonical for `dsw`-managed skills.
  - Define the index format (title, description, path, source, enabled) that the wrapper injects into the system prompt, and the discovery precedence (skill-root flag > DEEPSEEK_SKILLS_DIR > `~/.deepseek/skills` > `~/.codex/skills` > workspace `.deepseek-watch/skills`).
- [x] Update the DeepSeek CLI (`dsw`/`d`) with a `skill` command group.
  - `dsw skill list`, `dsw skill read <name>`, `dsw skill install <name|repo|path>`, `dsw skill create <name>`, `dsw skill remove <name>`, `dsw skill sync` (workspace ↔ global), and `dsw skill doctor` for broken/duplicate skills.
  - Support installing a skill from a local path, a workspace `.deepseek-watch/skills` entry, or a GitHub repo (like `codex skill install` / the skill-installer flow).
  - Add a `--skill-root`/`DEEPSEEK_SKILLS_DIR` override consistent with existing flag/env behavior, and surface loaded skills in `dsw doctor`.
  - Migration path: optionally copy existing `~/.codex/skills/*` into the DeepSeek root with a `--migrate-from-codex` flag (never mutate `~/.codex/skills`).
  - [x] Tests: index injection (frontmatter parsing, malformed SKILL.md), precedence order, install/sync round-trip, and a regression that a skill added mid-session is picked up on the next run (`npm run test:skills`).
