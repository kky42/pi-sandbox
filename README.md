# @kky42/pi-sandbox

Pi-compatible sandbox extension for filesystem-aware bash and tool enforcement.

## Usage

From this repo:

```bash
npm install
pi -e ./index.ts
```

Or from the extension directory:

```bash
pi -e .
```

Inside Pi:

```text
/sandbox
/sandbox on
/sandbox off
```

## Behavior

- `bash` commands are wrapped with `@anthropic-ai/sandbox-runtime` filesystem policy.
- Network is unrestricted.
- `write` and `edit` are allowed only in the workspace or temp directories.
- Sensitive write names are denied: `.env`, `.env.*`, `*.pem`, `*.key`.
- `read`, `grep`, `find`, and `ls` are blocked for sensitive home paths: `~/.ssh`, `~/.aws`, `~/.gnupg`.

The extension preserves Pi's built-in tools and enforces policy through extension events instead of replacing tool definitions.
