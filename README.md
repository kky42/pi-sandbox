# @kky42/pi-sandbox

Pi-compatible sandbox extension for filesystem-aware bash and tool enforcement.

## Install

Install globally with Pi:

```bash
pi install npm:@kky42/pi-sandbox
```

Or install for the current project:

```bash
pi install -l npm:@kky42/pi-sandbox
```

After installation, Pi loads the extension automatically. Extension flags are available on normal `pi` runs:

```bash
pi --sandbox on
pi --sandbox off
pi --sandbox-config ./sandbox.json
```

Try without installing:

```bash
pi -e npm:@kky42/pi-sandbox --sandbox on
```

From a local checkout:

```bash
npm install
pi -e . --sandbox on
```

## TUI commands

Inside Pi:

```text
/sandbox
/sandbox on
/sandbox off
```

The TUI status line displays `sandbox on` or `sandbox off`.

## Config discovery

The extension loads the first existing config file in this priority order:

1. `--sandbox-config <file-path>`
2. `<cwd>/.pi/sandbox.json`
3. `~/.pi/sandbox.json`
4. built-in defaults

See [`sandbox.example.json`](./sandbox.example.json) for the default config shape.

## Platform support

- macOS: supported.
- Linux: supported when `bubblewrap`, `socat`, and `ripgrep` are installed.
- Windows: not supported for bash sandboxing.

On Linux, install requirements with your OS package manager, for example:

```bash
sudo apt install bubblewrap socat ripgrep
```

When sandboxing is unavailable and sandbox is on, bash commands are blocked. Run `/sandbox off` or start with `--sandbox off` only if you want to allow unsandboxed bash.

## Default behavior

- `bash` commands are wrapped with `@anthropic-ai/sandbox-runtime` filesystem policy.
- Network is unrestricted.
- `write` and `edit` are allowed only in configured write roots.
- Default write roots are the workspace (`.`) and temp directories.
- Sensitive write names are denied: `.env`, `.env.*`, `*.pem`, `*.key`.
- `read`, `grep`, `find`, and `ls` are blocked for sensitive home paths: `~/.ssh`, `~/.aws`, `~/.gnupg`.

The extension preserves Pi's built-in tools and enforces policy through extension events instead of replacing tool definitions.

## Discoverability

This package includes the `pi-package` keyword and a `pi.extensions` manifest, so it is installable by Pi and eligible for the pi.dev package gallery once npm/GitHub indexing picks it up.
