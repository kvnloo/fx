# Agent Plugins envelope over existing skills and MCP

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Close the product-contract gap described in upstream #390 without inventing a second extension runtime.

fx already owns skills and MCP. Agent Plugins should be a manifest/install envelope over those existing primitives.

## Minimal v0

Support inspection plus skills-only installation first:

- parse and validate `plugin.json`;
- discover immediate `skills/*/SKILL.md` children;
- copy managed components into profile-owned storage;
- record an installation receipt;
- remove deterministically by receipt.

MCP components can follow only after trust/permission behavior is proven.

## Security boundary

- Workspace plugins never auto-start.
- Managed installs live under `~/.fx/plugins/<name>/`.
- Plugin data is separate from plugin source.
- MCP commands, args, cwd, and environment variable names are shown before install.
- Existing MCP trust and permission machinery remains authoritative.
- One broken component does not disable sibling components.
- Unknown extension namespaces are ignored, not executed.

## Cross-harness lessons

Hermes and OMP have broad skill/plugin ecosystems. fx should use the interoperable packaging benefit while rejecting scheduler, hook, gateway, and hidden-runtime expansion.

## Acceptance criteria

- Typed manifest parser with bounded input.
- Inspection available in text and JSON.
- Deterministic install/remove receipt.
- Skills reuse the current managed skill path.
- MCP reuse, if added, goes through existing native MCP admission.
- Startup and binary-size deltas stay within existing gates.

## Kill criteria

Reject any design that adds a parallel skill loader, bypasses MCP trust, or autostarts repository-provided executables.
