# Tool category icons

Small monochrome SVG icons for the Switchyard desktop UI. Each icon is an
original, simple outline drawing meant to read clearly at 16px on the dark
theme.

## Conventions

- `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
  `stroke-width="1.7"`, round line caps and joins.
- Color comes from the surrounding CSS `color`, so icons follow the theme and
  hover/active states without edits.
- Only `svg`, `g`, `path`, `circle`, `rect`, `line`, `polyline`, `polygon`,
  and `ellipse` elements. No text, scripts, links, `style`, external
  resources, animation, or event attributes, so the markup is safe to inline.
- Icons carry `aria-hidden="true"`; put the accessible label on the
  containing element.

## Mapping

| Icon | Shape | Tool category |
| --- | --- | --- |
| `tool.svg` | Wrench | Generic or unrecognized tool calls (fallback) |
| `terminal.svg` | Console window with prompt | `functions_shell_command`, `run_cmd`, `run_powershell` |
| `read.svg` | Open book | `read_text_file`, `functions.read_text_file` |
| `edit.svg` | Pencil | `write_text_file`, `patch_text_file` and their `functions.*` aliases |
| `search.svg` | Magnifier | Workspace/content search tools |
| `browser.svg` | Globe | `web_search`, `functions.web_search`, page fetch and browser tools |
| `agent.svg` | Robot head | Delegated agents, swarm/coordination messages |
| `image.svg` | Picture frame | Image viewing or generation tools |
| `plan.svg` | Checklist | `functions.update_plan`, `create_goal`, `get_goal`, `update_goal` |
| `mcp.svg` | Plug | MCP server tools |
| `files.svg` | Folder | Directory listing and file-management tools |

Unknown tool names should fall back to `tool.svg`.
