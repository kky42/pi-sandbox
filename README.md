# @kky42/pi-sandbox

Pi-compatible sandbox extension for filesystem-aware bash and tool enforcement.

## Install

```bash
pi install npm:@kky42/pi-sandbox
```

## Built-in modes

- `readonly` - sandboxed bash, no writes
- `on` - sandboxed bash with workspace writes by default
- `off` - no sandbox enforcement

When installed, the extension defaults to `on`, so a normal `pi` run starts with sandboxed workspace writes.

CLI:

```bash
pi --sandbox readonly
pi --sandbox on
pi --sandbox off
```

Slash command:

```text
/sandbox readonly
/sandbox on
/sandbox off
```

## Custom config

Put a JSON config in one of these locations, or pass one explicitly:

```bash
pi --sandbox on --sandbox-config ./sandbox.json
```

Resolution order:

1. `--sandbox-config <file-path>`
2. `<cwd>/.pi/sandbox.json`
3. `~/.pi/sandbox.json`
4. built-in defaults

`allowWrite` paths are resolved against the current workspace, so `.` means the folder you started Pi in.

Use [`sandbox.example.json`](./sandbox.example.json) as the starting shape.
