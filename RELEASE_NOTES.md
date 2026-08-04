# Release Notes — Plugin Maintenance

## 0.2.0 — 2026-08-04

### Added
- **Folder import** — point *"+ Plugin → Directory"* at a **local folder without Git**
  (e.g. `D:\ais\MyPlugin`): the folder is copied into the workspace with its full
  structure (`js/lib/**`, css, data, …) and runs the same flow as a Git clone
  (immediate scan → libraries → mock). Your original folder is **never touched**;
  re-assigning syncs the copy and keeps its mock/baselines.
- **Detect IDs from APEX** — in *Settings → APEX target* you now only need base URL,
  workspace and login: **🔍 Detect IDs from APEX** signs in to the target instance,
  fills **Workspace‑ID** and **Owner (parsing schema)** automatically and lists the
  workspace's apps so you can pick the dedicated test app (it never picks one for
  you). Switching apps resets stale per‑plugin test‑page registers. A manual
  fallback (SQL Workshop query / export-file header) is documented in the README.
- **Approval gate for unmaintained libraries** — replacing or rebuilding a dead
  library is never done silently anymore: each run proposes a plan
  (*Approval needed*) and waits for **Approve & replace**, or you enable
  *Settings → General → Auto‑replace unmaintained libraries*. Results are still
  adopted only if the plugin works as before, otherwise rolled back.
- **Adapter-vs-rewrite rule** — an alternative library is only used when it is
  commercially free, **obligation‑free** (MIT/ISC/0BSD — attribution already counts
  as an obligation) and functionally equivalent: then only an **adapter** is
  written and the plugin's own code stays untouched. Otherwise the used capability
  is **rewritten from the characterized interfaces** (own MIT code). Consequence:
  mxGraph→maxGraph (Apache‑2.0) routes to rewrite; moment→dayjs and
  jsonpath→jsonpath-plus remain adapter candidates.
- **AI‑SETUP.md** — an AI‑facing onboarding guide: hand it to an AI assistant and it
  configures the tool for you (prerequisites, settings, plugins, guardrails).

### Fixed
- **Library detection now works in all three vendoring forms** (the "which software
  is used" failure seen with a Leaflet plugin):
  - complete **checkout folders** under `lib/<name>/` count as ONE library (name from
    the folder, version from its `package.json` or the shipped file's banner) — no
    more dozens of fake `…@unknown` entries from spec/test/build files;
  - **flat single files** (file import stores basenames only) are recognized via the
    known‑names registry (now including Leaflet & Leaflet.markercluster);
  - libraries **embedded only in the export `.sql`** are decoded from the classic
    HEX format (`varchar2_to_blob(g_varchar2_table)` with chunk pre‑blocks) and
    fingerprinted by header — importing just the `.sql` is enough.
- File import runs the scan **immediately** — libraries/test plan no longer stay
  empty until the first check.
- Artifact detection no longer splinters library checkouts into fake "plugins"
  (leaflet, `…-master`, `src`); ESM files (`import`/`export`, `import.meta`) parse
  cleanly instead of producing false lint errors; LICENSE/image plugin files no
  longer produce "unsafe extraction" noise.
- The works‑as‑before gate compares **the same mock scenarios** against updated
  libraries instead of two independently AI‑generated mocks — no more false
  "visual regression" rollbacks.
- The overview API now exposes each plugin's repo source — *Check all → auto‑repair*
  actually reaches action‑needed plugins again.
- Security hardening: the configured APEX base URL is schema/host‑validated before
  credentials are sent (https only outside localhost); symlink‑safe path containment
  for re‑injection and re‑embed; SQLcl only executes export files inside an allowed
  directory.

### Changed
- The entire user‑facing surface is **English** now: GUI, launcher menus
  (`Start.cmd`/`start.sh`), CLI/console output, progress steps, backend error
  messages and the report mail. Internal status values are unchanged.
- README documents the approval flow, the adapter-vs-rewrite rule and the simple
  APEX‑target setup (Detect button + manual fallback).

## 0.1.0 — initial public release

Standalone Node.js tool (Node ≥ 20, dependency‑light) that autonomously maintains
Oracle APEX **plugins** and **template components**:

- **Detect & inventory** — Git URL or file import; type/format recognition
  (APEX SQL export vs. raw sources), per‑plugin SBOM (CycloneDX).
- **Library health** — vendored‑library fingerprinting with version detection,
  online currency/age check (npm), CVE lookup, unmaintained/EOL scoring, license
  watch (flags license *changes* on update, e.g. MIT → GPL).
- **AI characterization mock** — the AI analyzes the plugin and builds a
  self‑testing mock page (multiple views, real feature assertions) that serves as
  the reviewable "works as before" specification.
- **Full maintenance pipeline** — one button: sync → check → security & quality
  review → auto‑fix → safe library updates (re‑embedded into the `.sql` bundles) →
  **works‑as‑before gate** with rollback → re‑test → report. Crash‑safe run guard
  with startup recovery; cancellable runs.
- **Live APEX deploy & test** — installs into a dedicated test app (own registered
  page per plugin), builds the test page in the Page Designer generically for
  region/item/DA/template‑component plugins, headless render smoke test; the
  friendly URL is linked in the GUI ("open test page").
- **Ship it** — commits fixes on a new branch and pushes to any Git host
  (PAT or Git Credential Manager), PR/MR link in the GUI and report mail;
  scheduled unattended runs (cron) with email reports (SMTP).
- **Web GUI** — sortable overview with health bars and badges, per‑plugin drawer
  (overview / libraries / tests / protocol / notes), settings with connection
  tests, busy/cancel handling, issue reporting that turns a bug description into a
  permanent regression test.
- **mcp-apex-deploy** — bundled standalone MCP server (stdio, dependency‑free) for
  headless APEX import via SQLcl or the APEX UI, test‑page setup from a JSON
  manifest, reusable Playwright automation library.
- **Safety** — secrets encrypted (AES‑256‑GCM), never logged; pushes are gated and
  confirmed; reserved APEX pages are never overwritten; honest reporting when
  something cannot be verified.
