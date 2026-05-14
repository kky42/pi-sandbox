# @kky42/pi-sandbox

Pi-compatible sandbox extension for filesystem-aware bash and tool enforcement.

## Install

```bash
pi install npm:@kky42/pi-sandbox
```

## Built-in Choices

- `read-only` - sandboxed bash, no writes
- `workspace-write` - sandboxed bash with workspace writes by default
- `danger-full-access` - no sandbox enforcement

When installed, the extension defaults to `workspace-write`, so a normal `pi` run starts with sandboxed workspace writes.

CLI:

```bash
pi --sandbox read-only
pi --sandbox workspace-write
pi --sandbox danger-full-access
```

Slash command:

```text
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
```

## Custom config

Pass a JSON config explicitly to use a custom sandbox policy:

```bash
pi --sandbox-config ./sandbox.json
```

`--sandbox-config <path>` loads one complete policy and makes `config` the active sandbox choice. If both `--sandbox` and `--sandbox-config` are passed, the custom config is used and `--sandbox` is ignored.

Custom config is not auto-discovered. The extension does not read `<cwd>/.pi/sandbox.json` or `~/.pi/sandbox.json`.

During a session:

```text
/sandbox config
```

restores the startup `--sandbox-config` policy. Built-in choices selected with `/sandbox read-only`, `/sandbox workspace-write`, or `/sandbox danger-full-access` use the built-in policy and do not merge custom config values.

`allowWrite` paths are resolved against the current workspace, so `.` means the folder you started Pi in.

Custom config must include explicit `filesystem.denyRead`, `filesystem.allowWrite`, and `filesystem.denyWrite` arrays. Invalid or incomplete config warns and falls back to built-in `workspace-write`.

Use [`sandbox.example.json`](./sandbox.example.json) as the starting shape.
