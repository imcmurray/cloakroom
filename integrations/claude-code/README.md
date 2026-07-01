# Cloakroom × Claude Code

Wire the `cloak` CLI into Claude Code so real secrets never enter the model's context.
Full explanation and trade-offs: [`../../docs/CLAUDE-CODE.md`](../../docs/CLAUDE-CODE.md).

## What's here

- `settings.guard.json` — **guard profile** (recommended). A `PreToolUse` hook that
  blocks reading a secret-laden file into context. Robust; no decoy-reasoning.
- `settings.transparent.json` — **transparent profile**. `PostToolUse` sanitizes
  `Read`/`Bash`/`Grep` output into decoys before the model sees it; `PreToolUse`
  restores real values before a `Write`/`Edit` hits disk. The "magic" mode — see the
  doc for its sharp edges (needs `$CLOAK_SESSION_BRIDGE` + `$CLOAK_PASS`; scope away
  from source edits).
- `commands/cloak-sanitize.md` — a `/cloak-sanitize` slash command for the
  explicit, on-request "clean this file for me" flow.

## Install

```bash
# from the repo root
npm run build:cli && npm link      # puts `cloak` on PATH

# copy the "hooks" block from ONE profile into your settings:
#   .claude/settings.json        (this project only)
#   ~/.claude/settings.json      (all projects)

# slash command:
mkdir -p .claude/commands && cp integrations/claude-code/commands/cloak-sanitize.md .claude/commands/
```

Use the **guard** profile or the **transparent** profile, not both — the guard would
deny the reads the sanitizer wants to transform.

If you don't want `cloak` on PATH, replace `"command": "cloak hook guard"` with the
absolute path, e.g. `"node /abs/path/cloakroom/dist-cli/cloak.mjs hook guard"`.
