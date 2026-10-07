---
name: dsw-skill-install
description: Discover and install Switchyard's bundled skills during a session, and understand what sources are trusted.
---

# Install Switchyard skills

Switchyard discovers skills from user-configured roots and its bundled `skills/` catalog. Bundled skills are readable immediately and do not need to be installed first.

## Find and load a skill

1. Call `list_skills` and look for a matching entry. Bundled catalog entries show `source: bundled`.
2. Call `read_skill` with the exact skill name to load its instructions into the current turn.
3. If the user wants it copied into their persistent `~/.deepseek/skills/` directory, call `install_skill` with that bundled name. It can be read immediately afterward without restarting.

The model-facing `install_skill` tool only copies a skill shipped in Switchyard's catalog. It cannot fetch arbitrary GitHub repositories or paths. Use `switchyard skill install <repo-or-path>` from the CLI for explicit user-requested third-party installation; do not fetch or install remote skills without the user's request.
