# Switchyard releases

## v0.3.0 — 2026-09-21

The Switchyard rebrand brings a shared terminal interface to DeepSeek, GLM,
Anthropic Claude, and OpenAI GPT, plus native Codex and Claude Code connections.

### Added

- Provider and model selection during startup, live model catalogs, and local
  `/commands`, `/model`, `/provider`, `/usage`, and `/session` commands.
- API model pricing per million tokens, with cheapest-example sorting and
  explicit unknown prices. Reference rates checked September 21, 2026.
- Native Codex and Claude Code login, streaming, permissions, and session resume.
- A terminal renderer with styled messages, a composer, resize handling,
  scrolling, queued input, and expandable reasoning and tool results.
- Provider-aware transports, automatic caching, balance handling, update checks,
  and Docker tooling.

### Changed

- `switchyard` is the main command and Windows executable. Existing `d`, `dsw`,
  `dsd`, and `dswait` commands remain available.
- Context compaction replaces the older prefix, retains 15 complete tool-safe
  turns, and uses a deterministic fallback when summarization fails.
- Provider-specific compaction requests and session metadata support API model
  changes while preserving tool-call/result pairs.
- Installer and desktop window branding now use Switchyard.

### Compatibility and limits

- The legacy npm package identifier and configuration/session directories remain
  unchanged so existing installs and saved sessions keep working.
- Native Codex/Claude Code sessions resume within their own engine. Their tools
  and compaction are managed by that engine; cross-engine session migration and
  native-worker integration with Switchyard coordination are not yet supported.
- Price examples are references, not spending caps. Model availability and
  provider billing modifiers still apply.
- Windows standalone binaries provide CLI functionality. Electron UI requires
  the source installation and its dependencies.

## 0.2.0 - 2026-08-21

This checkpoint adds the bounded research and sandbox foundation.

- Added DeepSeek and GLM provider configuration, including dynamic model context limits and automatic compaction thresholds.
- Added bounded code search with match limits, pagination, minified-file detection, snippets, offsets, and artifact-backed raw results.
- Added task workspaces and artifact listing, range retrieval, and bounded search.
- Added named Docker sandbox profiles and a unified sandbox execution/lifecycle interface.
- Added task scope state, hypothesis tracking, viability decisions, and ROI records.
- Added first-pass PE triage and structured TShark-backed PCAP queries.
- Added coordinator-aware prompt guidance and stricter tool-call/PowerShell reliability rules.
- Added focused self-tests and included the new modules in the project check script.

The Docker profiles and specialist analysis interfaces are foundational in this release; images and integrations that require external tools are not represented as fully live-tested production workflows yet.
