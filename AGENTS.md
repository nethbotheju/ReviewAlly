# AGENTS.md

## Project Overview

ReviewAlly — AI-powered pull request code review GitHub Action (`nethbotheju/reviewally@v1`). Users bring their own LLM key (OpenAI, Anthropic, or OpenAI-compatible). The action reads PR diffs via the GitHub API, sends them to a configured LLM for review, and posts the result as a structured PR review comment as `reviewally[bot]`.

Two review modes:
- **standard** — single-pass LLM call with the diff + PR description
- **agent** — spawns `@earendil-works/pi-coding-agent` headless as the review harness, with read-only tools (`read`, `grep`, `find`, `ls`) backed by a local repo snapshot

Branded identity comes from a hosted token minter (`minter/`, see below): consumers install the ReviewAlly App and pass `app-token-url` — zero app secrets on their side.

## Setup Commands

- Install dependencies: `npm install`
- Type-check: `npm run typecheck`
- Build (typecheck + ncc bundle): `npm run build`
- Bundle only (skip typecheck): `npm run bundle`
- Test: `npm test` (vitest)
- Watch tests: `npm run test:watch`
- Lint: `npm run lint` (eslint)
- Format check / fix: `npm run format:check` / `npm run format` (prettier, `src/**/*.ts`)

## Development Workflow

- All source code is in `src/`. The bundled output goes to `dist/`.
- `dist/` is committed (GitHub Actions runs the compiled bundle from `dist/index.js`).
- Use `npm run bundle` after making source changes, then commit both `src/` and updated `dist/`.
- For quick iteration, edit source files and run `npm run build` to verify everything compiles.
- The action.yml references `dist/index.js` — make sure it's up to date before tagging a release.

## Testing Instructions

- Run all tests: `npm test`
- Tests live in `src/**/*.test.ts` and `minter/**/*.test.ts` (both matched by vitest.config.ts)
- Unit tests cover: path containment, tree building, pi arg/env/models.json generation, JSONL parsing, prompts, mock LLM interaction, app-token fetch/retry, PEM/DER handling with real RSA keys
- `.github/workflows/reviewally.yml` dogfoods the action on its own PRs (posts as `reviewally[bot]`); `.github/workflows/build.yml` runs CI
- When changing prompt logic, update the corresponding `prompt.test.ts`

## Code Style

- TypeScript with strict mode (`strict: true` in tsconfig.json)
- Uses `@vercel/ncc` for bundling (CJS output)
- `npm run lint` (eslint) and `npm run format:check` (prettier) gate CI alongside `tsc --noEmit` — run `npm run format` before committing
- Import ordering: Node built-ins → external deps → internal modules (relative paths)
- Use `import type` for type-only imports
- Async functions use `async/await` over raw promises
- Error handling: use `core.setFailed()` for action-level failures, `core.warning()` for recoverable issues
- Comments: keep to a minimum — only where the code is genuinely non-obvious

## Project Structure

The codebase is organized around the two review **modes** (`standard`, `agent`). Each mode lives under `modes/<mode>/` with its own runner; truly cross-cutting concerns live at the top level.

```
src/
  index.ts                   # entry: resolve inputs → branded token swap → trigger → mode dispatch → post
  config/
    inputs.ts                # action input parsing (enforces https:// on app-token-url)
    variables.ts             # REVIEWALLY_* repo-variable layer: resolution chain + run-summary rows
    types.ts                 # ActionInputs, RawActionInputs, ApiType, ReviewMode, RepoRoot
  github/
    api.ts                   # octokit calls: fetch PR/files, tarball, docs, post review, react
    trigger.ts               # event/trigger resolution (PR label, comment, auto)
    app-token.ts             # fetchAppToken — minter client (timeout + retry, AppNotInstalledError)
  shared/
    types.ts                 # AnnotatedLine, ChangedFile, FetchResult, ReviewComment, ReviewDocument, ReviewResult
    util.ts                  # truncate, isExcluded, resolveExcludes
    prompt.ts                # buildSystemPrompt + buildAgentSystemPrompt + buildUserPrompt
    parse.ts                 # parseReview — lenient JSON parser (standard mode only)
    patch.ts                 # annotatePatch — unified diff → annotated lines (old+new numbers)
    format.ts                # formatReview + formatNoChanges — standard-mode markdown body
  modes/
    standard/
      runner.ts              # runStandardReview — single-turn generateText
      models.ts              # createModel factory (OpenAI, OpenAI-compatible, Anthropic)
    agent/
      runner.ts              # runAgentReview — snapshot + pi engine + tool-call collection
      snapshot.ts            # tarball download + extraction + tree builder
      pi-args.ts             # PI_PACKAGE, providerFor, buildModelsJson, buildPiArgs, buildPiEnv
      pi-process.ts          # ensurePiInstalled + runNpm + invokePi (LF-only JSONL streaming)
      pi-output.ts           # parsePiOutput + messageText (events → ReviewResult)
      pi-types.ts            # PiEvent / PiMessage (JSONL event shapes, incl. tool events)
      reviewally-tools.js    # pi extension registering get_diff / submit_finding / finish_review
                               # (plain-JS ESM, zero deps; copied into the pi config dir and
                               #  loaded via --extension; bundled as an ncc asset)
      tools.ts               # buildDiffsPayload + collectAgentToolCalls (events → findings/finish)
      validate.ts            # host-side finding validation (anchor, evidence, dedupe, caps)
      format.ts              # formatAgentReview — walkthrough body + inline comment bodies
      trace.ts               # pi run observability: live trace lines, transcript group/file, pi-log levels
minter/                      # NOT bundled into dist — deployed separately as a Worker
  worker.js                  # token minter: /token endpoint, caller validation, minting
  crypto.js                  # PEM/DER helpers (PKCS#1 → PKCS#8 wrap, proper TLV walking)
  crypto.test.ts             # real-RSA-key round-trip tests
  wrangler.toml              # routes api.reviewally.nethbotheju.dev
images/                      # brand assets (mascot variants)
examples/workflow.yml        # the single consumer-facing sample workflow
```

## Key Dependencies

| Package | Purpose |
|---|---|
| `ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` | LLM provider abstraction (generateText for standard mode) |
| `@actions/core` + `@actions/github` | GitHub Actions runtime + octokit client |
| `minimatch` | Glob matching for file exclusion |
| `tar` | Tarball extraction for repo snapshot (agent mode) |
| `vitest` | Test runner |

## Minter (branded-bot backend)

- Exchanges the run's workflow `GITHUB_TOKEN` for a 1h, repo-scoped ReviewAlly App installation token; the action then posts as `reviewally[bot]`
- Endpoint: `https://api.reviewally.nethbotheju.dev/token` (GitHub App: `reviewally`, ID `4370940`)
- Only workflow tokens (server-to-server `ghs_`) are accepted; PATs are rejected
- Deploy: `cd minter && npx wrangler deploy` — required after any `minter/` change (source changes alone do nothing until deployed)
- Secrets (already set): `APP_ID`, `GITHUB_APP_PRIVATE_KEY` (via `wrangler secret put`)
- If minting fails or the App is not installed, the action warns and falls back to the workflow identity — branding never fails a run

## Agent Mode Details

- Agent mode downloads the full repo as a tarball via octokit (`github/api.ts`)
- Extracts to a temp dir and spawns `@earendil-works/pi-coding-agent` headless against it
- pi runs with read-only tools (`read`, `grep`, `find`, `ls`) plus ReviewAlly's `get_diff`, `submit_finding`, and `finish_review` (registered by `agent/reviewally-tools.js`, loaded via `--extension` and fed PR patch data through `REVIEWALLY_DIFFS_FILE`) — no shell, no write, no GitHub-write tool
- The model's final message is plain prose, never a JSON review: findings and the completion summary are collected from `tool_execution_*` events (`agent/tools.ts`) and re-validated host-side (`agent/validate.ts`) against the PR patches and head snapshot before anything is posted
- After the run, the PR head is re-fetched; if it moved, the review posts as a partial walkthrough without inline findings (`index.ts`)
- The API key is injected via environment variable (never argv); `openai-chat-compatible` endpoints are configured via an ephemeral `models.json` (`agent/pi-args.ts`)
- pi is installed on each run into `~/.cache/reviewally-pi/<version>` (`npm install`, a few seconds); `pi-version` controls the version, `pi-timeout-ms` is the hard kill timeout (pi has no built-in step cap)
- pi emits a JSONL event stream (`--mode json`, LF-terminated records only) parsed by `agent/pi-output.ts` and `agent/tools.ts`; `pi-log` (off/compact/full) streams one readable line per tool call/message into the Actions log, the raw transcript is always saved to `RUNNER_TEMP/pi-transcript.jsonl`, and a timeout resolves with partial events (timedOut=true) instead of discarding them — the run then posts an explicit partial review
- Tarball too large → auto-degrades to standard mode

## Build and Release

- Build: `npm run build` → outputs `dist/index.js` (single-file bundle)
- The action is consumed via `uses: nethbotheju/reviewally@v1` (old `ai-code-review` name redirects)

Every release uses **two tags** that must point at the same commit:

- A specific **version tag** (e.g. `v1.4.0`) — immutable record of that release.
- A moving **major tag** (`v1`) — always tracks the latest release on the current major. Consumers pin `@v1` to auto-follow releases within the major.

```bash
git tag v1.4.0
git push origin v1.4.0

git tag -f v1
git push origin v1 --force
```

## Common Gotchas

- Test files import `../config/types` and `../shared/types` separately — ActionInputs are in config, domain types in shared.
- The model factory in `src/modes/standard/models.ts` conditionally includes `baseURL` only when provided — do NOT pass it unconditionally for `openai`/`anthropic` types (SDK auto-injects the default).
- `dist/` MUST be committed — GitHub Actions runs the compiled bundle, not TypeScript source.
- The pi engine is NOT bundled — it's installed at runtime via `npm install` on the runner (`agent/engine/install.ts`). The `dist/index.js` bundle stays ~4MB; pi's ~170MB of deps live in the install dir.
- The minter is NOT part of the bundle either — changes to `minter/` go live only after `wrangler deploy`.
- `app-token-url` must be `https://` — enforced at input parse time (`config/inputs.ts`).
- The repo-variable config layer reads `REVIEWALLY_*` from **env**, never the REST API: `GITHUB_TOKEN` is not an allowed token for `GET /repos/{owner}/{repo}/actions/variables` (that needs an App token or PAT with the "Variables" read permission, and `actions: read` does NOT grant it). Workflows therefore forward values with `env: REVIEWALLY_MODEL: ${{ vars.REVIEWALLY_MODEL }}`. Resolution is workflow input > repo variable > built-in default, and validation runs on the *resolved* value — see `config/variables.ts`.
- The dogfood model (`deepseek-v4-flash` via OpenCode Zen) was chosen because it reliably returns JSON for standard mode; models that answer in prose break `parseReview` (standard mode only — agent mode reports through tools and tolerates prose).
