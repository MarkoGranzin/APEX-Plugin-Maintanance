# Security

## Reporting a vulnerability

Please open a private security advisory on the repository (GitHub → *Security* →
*Report a vulnerability*) rather than a public issue. Include a description, affected
file/function, and a reproduction if possible.

## Trust model

Plugin Maintenance is a **local, single-operator developer tool**. It runs on your machine,
against repositories and an AI backend **you** configure, and it acts with your local
privileges. It is not a multi-tenant service and has no network-facing authentication of its
own. Treat its configuration (`data/`, `.mcp.json`, settings) as trusted input — anyone who
can write those files already has your local privileges.

Within that model the following hardening is in place.

## Secrets

- API keys and Git tokens are stored **AES-256-GCM encrypted** in `data/secrets.json`; the
  master key comes from `AISPP_MASTER_KEY` and is never persisted.
- Secrets are **never logged** and only shown masked. Short secrets are fully masked (no
  head/tail reveal).
- `.mcp.json`, `data/`, `.env*` and key material are **git-ignored** and were never committed
  (verified against the full history). Use `.mcp.json.example` as a placeholder template and
  keep credentials in environment variables (`${VAR}`).
- Git push tokens are injected only into a one-time push URL, never written to `.git/config`.
- The optional AI CLI **headless key** is stored AES-256-GCM encrypted (via the secret store), never
  logged, and injected only into the spawned `claude` child process' environment (`ANTHROPIC_API_KEY`)
  — enabling unattended/scheduled runs without an interactive login. Without a key, the CLI falls back
  to the interactive login (unchanged behavior).

## Hardening implemented (from security review)

| Area | Mitigation |
|------|------------|
| Secret masking | Short secrets (<12 chars) are fully masked instead of exposing most of the value. |
| Asset re-injection | Writes are confined to the repo directory; `../`, absolute, and cross-drive paths are rejected. |
| Re-embed source lookup | Embedded file names from a (possibly foreign) plugin `.sql` cannot resolve outside the repo. |
| Test-spec writing | Generated spec files are written by basename only — a crafted name can't escape the spec dir. |
| SQLcl install script | The export path is rejected if it contains quotes or newlines (no break-out of `@"…"`). |
| AI provider endpoint | Must be a valid URL and use `https` (localhost may use `http`) so the API key is never sent in cleartext. |
| Generated test specs | A static pre-scan blocks specs that reference `child_process`, `require()`, dynamic `import()`, Node core modules, `eval`/`Function`, or `fs` access before they are written or executed. |
| Quick-fix scope | Deterministic quick-fixes (console.log/debugger removal) run only on real plugin runtime assets — build tooling (`gulpfile.js`, `*.config.js`) and demo/data files are skipped. |

## Accepted, by-design (documented residual risk)

Because the tool is operator-configured and local, a few review findings are intentional and
scoped by the trust model above:

- **Configurable AI CLI command** — `cli` backend spawns the command you set in *Settings*.
  That is the feature; it runs with your privileges. Only configure a command you trust.
- **AI-generated characterization tests** — the tool writes and runs Playwright specs produced
  by your configured AI backend. This is core functionality; run it against your own plugins
  with an AI backend you trust. A static pre-scan (above) rejects specs that reach for Node
  capabilities a DOM test never needs, but the execution itself is not fully sandboxed.
- **Local MCP servers without auth** — the bundled MCP servers use a local trust model (no
  auth), consistent with stdio MCP over localhost.

## Example fixtures

Files under `examples/` are **test fixtures**, not runtime dependencies. For instance
`examples/sample-repo/colorpicker/colorpicker.sql` intentionally references an outdated jQuery
from a placeholder host (`cdn.example.com`) so the tool's outdated-library detection has
something to detect. These are not shipped or executed.
