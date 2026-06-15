# DeployHub CLI

A lightweight, zero-dependency command-line interface for the
[DeployHub](https://github.com/your-org/deployhub) hosting & domain automation
platform.

The CLI lets you manage your projects, deployments, environment variables and
domains straight from the terminal — perfect for CI/CD pipelines, scripting
and quick checks without having to open the web dashboard.

- **No external dependencies** — runs on Node.js 18+ using only built-in
  modules (`fetch`, `fs/promises`, `readline`).
- **Colorful, human-friendly output** — ANSI colors, tables, and a spinner for
  long operations.
- **Scriptable** — every list command supports `--json` for easy piping into
  `jq` or your own scripts.
- **Safe** — your API key is stored in `~/.deployhub/config.json` with mode
  `0600` and never printed to logs.

---

## Installation

The CLI ships as a single file (`cli/deployhub.mjs`) inside the DeployHub
repository. You have three options:

### Option 1 — Run directly with Node

```bash
node /path/to/deployhub/cli/deployhub.mjs help
```

### Option 2 — Link it globally (recommended)

From the project root:

```bash
bun link   # or: npm link
```

Then from anywhere:

```bash
deployhub help
```

### Option 3 — Symlink manually

```bash
chmod +x /path/to/deployhub/cli/deployhub.mjs
ln -s /path/to/deployhub/cli/deployhub.mjs /usr/local/bin/deployhub
deployhub help
```

> Requires Node.js 18 or newer.

---

## Getting an API key

The CLI authenticates with an **API key** (not your password). To create one:

1. Log in to your DeployHub dashboard.
2. Open **Settings → API Keys**.
3. Click **Create API Key** and give it a descriptive name
   (e.g. `laptop`, `ci`, `homelab`).
4. **Copy the key** immediately — it starts with `dh_` and is only shown once.
5. On your terminal, run:

   ```bash
   deployhub login dh_your_key_here
   ```

The key is saved to `~/.deployhub/config.json` (mode `0600`) and sent as
`Authorization: Bearer <key>` on every request. To rotate the key, simply
delete it from the dashboard and run `deployhub login` again with a new one.

---

## Configuration

The config file lives at `~/.deployhub/config.json`:

```json
{
  "apiKey": "dh_…",
  "baseUrl": "http://127.0.0.1:3000"
}
```

- `apiKey` — your DeployHub API key.
- `baseUrl` — where the DeployHub API is reachable. Defaults to
  `http://127.0.0.1:3000`. Override per-invocation with the
  `DEPLOYHUB_BASE_URL` environment variable if your dashboard is hosted
  somewhere else.

---

## Commands

### `deployhub login <api-key>`

Saves the API key to the config file and tests the connection by calling
`/api/auth/me`. Prints the authenticated user on success.

```bash
deployhub login dh_a1b2c3…
```

### `deployhub whoami`

Shows the currently authenticated user (name, email, role, current plan).

```bash
deployhub whoami
deployhub whoami --json
```

### `deployhub projects`

Lists all your projects in a table with name, framework, status and URL.

```bash
deployhub projects
deployhub projects --json
```

### `deployhub deploy <project-id|project-name>`

Triggers a deployment for the specified project. The project identifier can
be **either** the project's UUID **or** its name (case-insensitive). The CLI
polls the deployment every 2 seconds and streams build log lines as they
arrive.

```bash
deployhub deploy my-blog
deployhub deploy cm5v8x9qz0003mp08t2x4abcd
```

### `deployhub deployments [project-id|project-name]`

Lists recent deployments, optionally filtered by project. The table shows
project name, status, duration and time.

```bash
deployhub deployments
deployhub deployments my-blog
deployhub deployments --json
```

### `deployhub logs <deployment-id>`

Fetches and prints the full build log for a specific deployment.

```bash
deployhub logs cm5v8x9qz0003mp08t2x4abcd
```

### `deployhub env list <project-id|project-name>`

Lists environment variables for a project. **Values are masked** by default
(e.g. `sk****`) to avoid leaking secrets into your shell history. Pass
`--reveal` to fetch decrypted values.

```bash
deployhub env list my-blog
deployhub env list my-blog --reveal
deployhub env list my-blog --json
```

### `deployhub env set <project-id|project-name> <KEY=value>`

Sets (or updates) an environment variable. The value is encrypted at rest
before being stored. If the variable already exists, it will be updated
rather than rejected.

```bash
deployhub env set my-blog DATABASE_URL=postgres://user:pass@host:5432/db
deployhub env set my-blog STRIPE_SECRET_KEY=sk_live_abc123
```

> Tip: wrap values containing `&`, `;` or spaces in single quotes:
> ```bash
> deployhub env set my-blog FEATURE_FLAGS='a=1;b=2'
> ```

### `deployhub env delete <project-id|project-name> <KEY>`

Deletes an environment variable by key.

```bash
deployhub env delete my-blog OLD_API_KEY
```

### `deployhub domains`

Lists all your domains.

```bash
deployhub domains
deployhub domains --json
```

### `deployhub help`

Shows the full command reference inline.

```bash
deployhub help
```

---

## Examples

### Scripting: deploy every project that is currently running

```bash
deployhub projects --json \
  | jq -r '.[] | select(.status=="running") | .id' \
  | xargs -I{} deployhub deploy {}
```

### CI: set env vars then deploy

```bash
deployhub login "$DEPLOYHUB_API_KEY"
deployhub env set my-app DATABASE_URL="$DATABASE_URL"
deployhub env set my-app REDIS_URL="$REDIS_URL"
deployhub deploy my-app
```

### Inspect the latest failed deployment

```bash
FAILED_ID=$(deployhub deployments --json | jq -r '.[] | select(.status=="failed") | .id' | head -n1)
deployhub logs "$FAILED_ID"
```

---

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `Network error contacting …` | The DeployHub API isn't reachable. Set `DEPLOYHUB_BASE_URL` to the right host or start the server. |
| `Authentication failed: Invalid or expired token` | Your API key was revoked or never set. Run `deployhub login <key>` again. |
| `Not authenticated. Run \`deployhub login …\`` | No API key in the config file. |
| Colors look broken when piping | The CLI auto-disables colors when stdout is not a TTY. You can also force-disable them with `NO_COLOR=1`. |

---

## License

Same license as the DeployHub platform.
