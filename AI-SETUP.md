# AI-SETUP — hand this to an AI assistant to configure Plugin Maintenance for you

**You are an AI assistant. Read this file top to bottom, then set the tool up so the human can start immediately.**
Everything below is executable: start the service, configure it through the GUI, add the plugins, run one maintenance pass, confirm it works. Ask the human only for the values marked **(ask the human)**. Follow the **Guardrails** at the end — they are not optional.

Plugin Maintenance is a standalone Node.js tool that autonomously maintains Oracle APEX **plugins** and **template components**: it detects vendored libraries, updates them safely, characterizes the plugin with an AI-built mock, runs a "works-as-before" gate, and can deploy + smoke-test the result in a real APEX app. It ships a small web GUI on `http://localhost:4317`.

---

## 0) TL;DR (minimal path to "ready to work")

1. Ensure **Node ≥ 20** and the **`claude` CLI logged in** (or have an Anthropic **API key** ready).
2. Set `AISPP_MASTER_KEY` (encrypts stored secrets), then start: **`Start.cmd`** (Windows) / **`./start.sh`** (macOS/Linux) → GUI opens at `http://localhost:4317`.
3. In **⚙ Settings**: set the **Working directory**, pick the **AI backend**, (optional) fill **APEX target**, **Git push**, **Email**, **Schedule**.
4. **+ Plugin** → add each plugin by Git URL (or file import). The tool clones, detects type/format, builds the mock.
5. Open a plugin → **🧰 Full maintenance**. When it's green, the human can work.

---

## 1) Prerequisites

- **Node.js ≥ 20** (`node -v`). If `node_modules/` is missing, the launcher runs `npm install`.
- **An AI backend** — one of:
  - **Local CLI** (`claude`): must be **logged in** in the *same interactive desktop session* that runs the service (OAuth login is session-bound). Verify with `claude --version`; log in with `claude` → `/login`.
  - **Provider + API key**: an `ANTHROPIC_API_KEY`. This works **headless** (scheduled/remote sessions) where an interactive login would not. **(ask the human for the key)**
- **Playwright** (Chromium) — needed for mock self-tests, coded UI tests and APEX render checks. Install it from the app: **Tests tab → Install Playwright** (or `npx playwright install chromium`).
- **SQLcl** on `PATH` — only if you will use **APEX deploy & live test**. Not needed for library maintenance.

---

## 2) Start the service

Set the master key **once** (used to encrypt every stored secret; without it an insecure dev key is used and the startup log warns):

```bash
# Windows (PowerShell):  $env:AISPP_MASTER_KEY = "<a long random passphrase>"
# macOS/Linux:           export AISPP_MASTER_KEY="<a long random passphrase>"
```

Then launch (opens the browser automatically):

- **Windows:** double-click **`Start.cmd`** (or `node start.js serve`)
- **macOS/Linux:** `./start.sh` (or `node start.js serve`)
- **Custom port:** `node start.js serve 4321`

**(ask the human)** whether they already run an instance (default port **4317**) — if so, do **not** start a second one on the same port; use a different port for experiments.

CLI without the GUI: `node start.js scan <repo-path>` (read-only analysis) · `node start.js test [name]` (run the managed plugins' tests).

---

## 3) Configure (do this in ⚙ Settings — the GUI, not raw API calls)

Open **⚙ Settings**; it has tabs. Fill them in this order:

### General
- **Working directory** — where each repo is cloned into its own subdirectory. Default `./workspace`. Keep it unless the human wants another location.
- **Auto-replace unmaintained libraries** — default **off**: replacing/rebuilding an unmaintained library needs the human's per-run approval. Leave it off unless the human explicitly asks for full autonomy.

### AI backend (required)
- **Backend:** `Local CLI` (recommended when `claude` is logged in) **or** `Provider + API key`.
  - *Local CLI:* **CLI command** = `claude` (leave it as the bare command, not a version-pinned path — a pinned path breaks when the CLI auto-updates). The panel shows a **login status**; if it says *NOT logged in*, click **🔑 Open login**, confirm the browser login, then **↻**.
  - *API key (optional even with CLI):* paste `ANTHROPIC_API_KEY` — it enables **headless** runs (scheduler/remote) and is stored encrypted. With CLI + no key, runs use the interactive login.
  - *Provider:* set **Endpoint** (`https://api.anthropic.com/v1/messages`), **Model** (e.g. `claude-opus-4-8`), **API key**.
- Click **🔌 Test connection** and confirm it's green before continuing.

### Git push (optional — only if the tool should push fixes/PRs)
- Either rely on the machine's **Git Credential Manager** (no token) **or** paste a **Personal Access Token** (write access to the target repo; stored encrypted, never logged). Works with GitHub/GitLab/Bitbucket/Azure/Gitea. **(ask the human)**

### Schedule (optional)
- Enable + **cron** (`0 3 * * 1` = weekly Mon 03:00). Headless scheduled runs need the **API key** backend (see above).

### Email report (optional)
- SMTP host/port/TLS/user/sender + **recipients**; password stored encrypted. Use **✉ Send report now** to test. **(ask the human)**

### APEX target (optional — only for "deploy & live test")
Use a **test app / test instance only** (see Guardrails). Preferred flow:
1. Enter only **Base URL (ORDS)** (`https://<host>/ords`), **Workspace**, **APEX Developer** (a developer or admin user of that workspace — the APEX sign-in username) and **Password**. **(ask the human for these + which app is the dedicated TEST app)**
2. Click **🔍 Detect IDs from APEX** — the tool signs in, fills **Workspace-ID** and **Owner (parsing schema)** automatically and lists the workspace's apps. Pick the dedicated **test app** from the list (never a real/production app; if none exists, have the human create an empty "Plugin Test" app first, then Detect again).
3. Click **🔌 Test connection**; expect *Login ok (App Builder reached)*.

*Manual fallback* (only if Detect fails on this instance): App-ID = the number on the app's tile in the App Builder; Workspace-ID + Owner via SQL Workshop → SQL Commands: `select workspace_id, sys_context('userenv','current_schema') from apex_workspaces;` — or from an app export header (`p_default_workspace_id` / `p_default_owner` in `wwv_flow_imp.import_begin`, older versions `wwv_flow_api.import_begin`). Report to the human that Detect failed (include the error) so it can be fixed.

---

## 4) Add the plugins

For each plugin the human names **(ask the human for the list / Git URLs)**:

- **+ Plugin** → **Name** + **Directory or Git URL** (e.g. `https://github.com/<org>/<plugin>`), **Visibility** public/internal, optional **PAT/SSH** for private repos → **Save**.
- No Git? Use **Import files** in the same dialog: at least one **`.sql`** export (+ optional JS/CSS/JSON).
- On save the tool clones, detects **type** (plugin / template component) and **format** (APEX export vs. raw sources), and builds the **mock** (the AI characterizes the plugin; needs the AI backend). Watch the row status / progress.

---

## 5) Run maintenance

Open a plugin (click its row → drawer) and use the icon actions:

- **▶ Check** — scan: libraries, SBOM, risks, test plan.
- **🧰 Full maintenance** — the full pipeline: sync → check → review → auto-fix → safe library updates → **works-as-before gate** (baseline mock vs. updated libs; rolls back on regression) → re-test → (if APEX target set) deploy + render smoke test → report. This is the one button that leaves a plugin "maintained and verified as before".
  - **Unmaintained libraries are never replaced silently.** The run proposes a plan and waits for approval (**Approve & replace** in the result panel). The rule: an alternative library is only used if it is commercially free, **obligation-free** (MIT/ISC/0BSD — attribution counts as an obligation) and functionally equivalent — then only an **adapter** is written (old API surface preserved, plugin code untouched). Otherwise the capability is **rewritten from the characterized interfaces** (own MIT code). Tell the human about pending proposals instead of approving on their behalf — unless they have explicitly turned on *Settings → General → Auto-replace unmaintained libraries*.
- **Open mock** — the AI-built characterization page (review artifact).
- **APEX test page** — opens the deployed live test page (deploy happens automatically inside Full maintenance).
- **🐞 Report issue** — describe a bug the tests missed; the AI turns it into a permanent regression test and reworks until green.

Run **Full maintenance** on each plugin once so the human starts from a green, verified state.

---

## 6) Verify it works (do this before telling the human you're done)

- **⚙ Settings → AI backend → Test connection** is green (and login status is *logged in* / *API key active*).
- At least one plugin shows a **green mock** (mock self-check passing) after Full maintenance.
- If an APEX target is configured: the plugin's **APEX test page** opens and renders.
- Tell the human concisely: which backend is active, which plugins are imported and green, and what (if anything) still needs their input (e.g. missing APEX/SMTP values).

---

## 7) Guardrails — follow these exactly

- **Run the service in the human's interactive desktop session** when using the `claude` CLI — its login is session-bound; a scheduled-task/headless session must use the **API key** backend instead, or generation fails with "not logged in".
- **The claude login can expire.** If mock/AI steps fail, check the GUI **login status** and re-login before blaming anything else. Keep the CLI command as bare `claude`, never a version-pinned executable path.
- **APEX: test instances only.** Never deploy onto a real/shared page. Each plugin gets its **own** test page (auto-assigned, page id ≥ 20000); never overwrite existing/reserved pages — APEX has no clean per-page restore.
- **Never delete the human's real data.** The live data lives under the data directory (default `./data`, override with `AISPP_DATA_DIR`). For experiments/QA, point `AISPP_DATA_DIR` at a **temp** directory instead of touching the real one.
- **Secrets stay encrypted.** They are stored via `AISPP_MASTER_KEY`; never print, log, or commit secrets, real hosts, tokens or the master key. Do not commit `data/`, `workspace/`, or `.mcp.json`.
- **Do outward-facing actions only on request.** Pushing to a remote / opening PRs happens only with a configured token and the human's intent; don't push to real repos as a side effect of a test.
- **Prefer the GUI** for configuration and maintenance so the real flow, guards and logging apply — don't drive it with ad-hoc shell `curl` calls.

---

## Appendix — reference

**Environment variables**
- `AISPP_MASTER_KEY` — passphrase that encrypts all stored secrets. Set it before first use; keep it stable.
- `AISPP_DATA_DIR` — override the data directory (components, settings, encrypted secrets, SBOMs). Use a temp path for experiments.

**Ports & layout**
- GUI/service default port **4317** (`node start.js serve [port]` to change).
- Data directory (default `./data`): `components.json`, `settings.json`, `secrets.json` (encrypted), `sbom/`.
- `workspace/<repo>/` — each managed repo's clone; the AI mock lives under `.maintenance/mock/`.

**REST endpoints** (the GUI buttons call these; use only if you must automate — the GUI is preferred)
- Settings/secrets: `PUT /api/settings` · `POST /api/ai/key` · `GET /api/ai/auth` · `POST /api/ai/login` · `POST /api/git/token` · `POST /api/smtp/pass` · `PUT /api/apex-target` · `POST /api/apex-target/test` · `POST /api/report/send`
- Components: `GET/POST /api/components` · `GET /api/components/:id` · per-plugin actions under `/api/components/:id/...` (check, maintain, mock, apex-live, purge) · `GET /api/scan?path=`
