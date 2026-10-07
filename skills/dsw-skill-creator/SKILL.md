---
name: dsw-skill-creator
description: How to create and register local skills for the dsw harness so future sessions discover new tools and procedures. Use whenever you add a new tool, command, or non-trivial workflow.
---

# dsw skill-creator

Skills are `SKILL.md` files the dsw harness discovers at session start.

## Where skills live (all auto-discovered)
- Harness repo: `skills/<name>/SKILL.md` — version-controlled and discovered from the bundled catalog by source installs and packaged executables
- Persistent user install: `~/.deepseek/skills/<name>/SKILL.md`
- Global (always found): `~/.codex/skills/<name>/SKILL.md`
- Workspace (cwd-relative): `.deepseek-watch/skills/<name>/SKILL.md`
- Extra roots via `--skill-root <dir>` or `DEEPSEEK_SKILLS_DIR`

## When to create a skill
Create one whenever you:
- add a new tool to the harness (e.g. a `sec_*` tool) — future sessions will not know it exists otherwise
- change tool behavior in a way callers must know (e.g. `patch_files` same-file ordering, CRLF tolerance)
- define a repeatable procedure (security scan workflow, adware cleanup, pbc tab automation)

Name skills with a `dsw-` prefix when they describe harness behavior, to avoid
colliding with Codex's built-in skills (e.g. `.system/skill-creator`).

## Format
```
---
name: kebab-case-name
description: One sentence — when to use this skill.
---

# Title

Concise, actionable body: purpose, commands, examples, gotchas. No fluff.
```

## Steps
1. Create `skills/<name>/SKILL.md` in the harness repo
2. Write the file with the frontmatter above
3. Verify with `switchyard --list-skills`; bundled skills are available without copying them globally
4. To persist a bundled skill for later sessions, use `switchyard skill install <name>` or the in-session `install_skill` tool. The latter only installs from Switchyard's bundled catalog and asks first in `ask` permission mode.
5. In-session: call `list_skills` to see skills and `read_skill <name>` to load one immediately; no restart is required after installation.
