# Proposal: an in-repository, evidence-based agent reviewer

**Status:** Implemented on the working branch for [#26](https://github.com/nethbotheju/reviewally/issues/26); not released. The SDK investigation, finding validator, walkthrough, inline posting, and default-on diagnostic trace are wired into agent mode. Live-provider and live-GitHub dogfooding remain before release.

## Goal and decisions

Build the review workflow **in this repository**, using the pi **SDK in-process** for repository investigation rather than invoking the pi CLI and extracting a JSON object from its final text. Keep the existing `standard` mode as a fast fallback. A review is an application-owned artifact: the agent may propose findings, but ReviewAlly validates and posts them.

- Keep `review-mode: agent`; do not create another repository or a new review mode. pi is a library dependency, not a separately authored ReviewAlly service or agent. Do not copy pi's source into this repository.
- Prefer the pi SDK because its read/grep/find/ls loop already works for this project. Do **not** assume importing the SDK into the `ncc` bundle will work: prove compatibility with the pinned package version and the Node 24 Action runtime first.
- Use **typed tool calls** to submit candidate findings, not fenced JSON in the final assistant message. A tool records candidates in memory; it never posts to GitHub. Validate every candidate before posting. A final prose message can describe scope/limitations but cannot by itself authorize a finding.
- Retain the same BYOK providers and snapshot-at-head approach initially. Neither the SDK nor a schema prevents hallucinations; source evidence and diff-position validation are independent gates.
- Track changed-file coverage, errors, and limitations explicitly. Do not present a partial review as full coverage.

## Current behavior and related work

Before this branch, `src/index.ts` fetched a PR and a **limited selection** of changed files, downloaded a head-SHA snapshot in agent mode, invoked the CLI's `runAgentReview`, called `parseReview` on the last assistant text, and posted a summary with **zero** inline comments. This branch replaces only the agent-mode execution path with `runSdkInvestigation` and host-owned validation/posting. `src/shared/types.ts` already defines `ReviewComment`; `src/github/api.ts` supports `pulls.createReview` with comments. `src/modes/agent/pi-args.ts`, `pi-process.ts`, and `pi-output.ts` implement runtime installation, CLI/JSONL transport, and last-message extraction. The model output schema has only summary/file descriptions/recommendations; no path/line/evidence for a finding.

Related issues: #10 proposes an engine selector (not a prerequisite for moving the pi engine to its SDK); #11 concerns pi provider/model config; #12 concerns linked issues; #24 concerns PR discussion; #17 documents JSON-format failures (closed). Avoid implementing those issues implicitly. If #10 lands first, preserve its mode/engine distinction; if this lands first, avoid introducing a speculative public selector solely for this change. #12 and #24 should feed the same context interface later without blocking the initial reviewer.

## Runtime and packaging gate (first deliverable)

1. Prototype `createAgentSession` using a **pinned** `@earendil-works/pi-coding-agent` dependency, ephemeral `cwd`, explicit provider/model and API-key configuration, `SessionManager.inMemory()`, a minimal host-owned resource loader, and a read-only tool allowlist. The prior CLI default was `0.82.1`; the SDK and agent-mode input default are pinned to `0.87.1` in this branch. Any other `pi-version` fails explicitly in agent mode until SDK compatibility is tested. Do not rely on the user's pi settings, global credentials, extensions, or project-supplied `.pi` configuration.
2. Verify local typecheck, `npm run build`/`ncc`, and an invocation of **the built `dist/index.js`** on the Action's Node 24 runtime. Check startup time and bundle size. **Phase 1 result:** pi SDK 0.87.1 is ESM-only; `ncc` cannot bundle its package export into ReviewAlly's CommonJS Action. `src/modes/agent/sdk-session.ts` instead loads the pinned library from an isolated runtime install; a separate `ncc` bundle of that entry successfully created a session with `read,grep,find,ls` on Node 24. The `dist/index.js` Action bundle now routes agent mode through this SDK session; it loads the library from the runtime installation. A local mock OpenAI-compatible provider exercises the real pi tool loop and produces a sample validated finding and walkthrough. Snapshot archive caps and path-checked pi built-in adapters are implemented; they are not an OS isolation boundary. Test the published Action with real providers and GitHub before removing old CLI files. Do not introduce a second repo.
3. CI tests include a real pi SDK tool loop against a localhost mock OpenAI-compatible endpoint, without a paid key. An opt-in dogfood run against a live provider and real PR is still required before release.

## Pipeline and ownership

```text
trigger + PR metadata + all changed-file metadata (base/head SHA)
  -> coverage selection + context manifest
  -> head snapshot + diff/patch index
  -> pi SDK session (investigates; submits candidates to in-memory tool)
  -> validation + deduplication + severity/quantity caps
  -> re-read PR head SHA; format summary + valid inline comments
  -> one GitHub COMMENT review, or a clearly marked no-findings/partial review
```

- **Host** (`src/index.ts`, `src/github/`, `src/modes/agent/`): selects scope, owns tokens and snapshots, controls time/budget, validates and posts. Keep the posting token out of model-callable tools. Read-only issue/context fetching is host-owned.
- **Agent**: reasons over PR intent and code, investigates relevant callers/tests/config, submits **candidate** findings. It cannot approve, request changes, comment, commit, or run arbitrary commands.
- **Shared** (`src/shared/`): typed review artifact, patch index, validators, formatter. Standard mode can continue using the old review shape until a deliberate migration; no behavioral change to standard is required for the first release.

## Context supplied to the agent

- Host fetches fresh PR title/body, PR base SHA and head SHA, changed-file metadata and patches, and project guidance. Explicitly include selected-file count vs total and why files were omitted. The current `maxFiles`/`maxDiffLines` limits only bound input; a repository snapshot is not proof every changed file was reviewed. Do not fabricate a complete diff when the GitHub Files API omits a patch or truncates it; mark that file unreviewed or fetch an authoritative bounded diff before allowing inline findings.
- Start with the PR body as intent. Integrate linked issue documents via #12 and PR discussion/review comments via #24 when those are available; bound sizes and include provenance, timestamps, and truncation markers. Issue claims and instructions found in PRs/files are **untrusted data**. Never automatically fetch arbitrary URLs found in their text.
- Provide the changed-file list and compact diff snippets as orientation, not the entire repository contents. The snapshot at the exact head SHA is searchable on demand. A base-SHA code view is a follow-on tool for questions about regressions; until then, require evidence that a reported defect is caused by the changed code rather than asserting it.
- Provide a short, host-authored tool and reporting policy. Do not import executable repo instructions from AGENTS/CLAUDE files or run user-provided extensions/skills; if useful, expose such files as bounded **context data** only. Extra instructions configured by the repository owner must not override tool or posting policies.

## SDK session and tools

Create a fresh session per PR run, point it at the extracted snapshot, dispose it and clean the snapshot in `finally`. Restrict active tools to `read`, `grep`, `find`, `ls` and the ReviewAlly tool(s) below. The initial prototype overrides pi's built-ins with host path-checked adapters that delegate to pi's existing implementations; this is not an OS sandbox. Configure resource discovery explicitly rather than relying on pi's defaults (the SDK normally discovers project/user resources and persists sessions). Do not enable `bash`, `edit`, `write`, network, browser, or user-defined extensions. `cwd` and read-only tool selection are **not security boundaries**: a local read tool may follow symlinks or access absolute paths; check this in the packaging spike.

Preferred tool API (names are indicative; verify the chosen pi SDK's tool registration/schema API):

| Tool | Model-facing input | Host behavior and limits |
| --- | --- | --- |
| `read`, `grep`, `find`, `ls` | Relative paths / search patterns | Investigation within the snapshot. Either wrap built-ins with host-owned safe tools or verify their path behavior and run pi in an OS-isolated environment; require root containment via canonical paths, reject symlink escapes, excluded paths, oversized/binary files and reads outside the root. Cap per-call bytes/results, total calls, elapsed time and aggregate context. |
| `get_diff` | Selected changed path, optional offset | Return a bounded/paged portion of the GitHub patch, with new-file line numbers and an incomplete-patch warning. |
| `submit_finding` | `path`, `line`, `title`, `impact`, `evidencePath`, `evidenceLine`, `evidence`, `suggestedFix`, `severity` | Record a bounded candidate in memory; only added lines in selected patches qualify. Revalidate anchor, evidence line and snapshot contents in the host. No GitHub API or filesystem write. |
| `finish_review` | Summary and limitations | Required for a completed result. Missing call or model error fails the agent review instead of implying no findings. |

Potential alternative: if `submit_finding` tool calling is unreliable for a configured provider, use an **explicitly supported** schema-validated second model call (e.g. existing AI SDK `Output.object`) over bounded evidence. Detect failure; do not silently JSON-repair and publish unchecked findings. If neither tool calls nor structured output is supported, return a clearly labeled limited/failed review according to a documented policy, not an invented clean bill of health. Model-specific capabilities must be tested, especially for OpenAI-compatible endpoints.

Session control: this branch caps tool calls and candidate findings and requests SDK cancellation on `pi-timeout-ms`; a workflow `timeout-minutes` is required for a hard kill because in-process cancellation cannot guarantee one. On cancellation/error, do not use partial model output. `REVIEWALLY_AGENT_TRACE` is on by default per product direction; it logs completed model messages and tool arguments/results to Actions logs, with known-token redaction and per-event/total caps. The README warns that private source and unknown secrets may appear in logs.

## Review artifact, validation, and GitHub posting

Host-owned types should distinguish `CandidateFinding`, `ValidatedFinding`, `ReviewSummary` and `ReviewCoverage`. A finding has a concise claim, real user impact, changed-file anchor, evidence references to inspected files, remedy, severity, and optional patch suggestion. Require every inline comment's path to be a selected changed file and its **RIGHT-side new line to be a reviewable position in the exact fetched patch** (prefer an added line; allow other positions only with an explicit, tested GitHub policy). The evidence can cite unchanged files but must not use them as inline anchors. For renamed/binary/deleted or missing-patch files, post an unanchored issue only in the summary with explicit location and uncertainty, or omit it; never invent a line.

Validator responsibilities: exact path/line membership against `annotatePatch` (fix/test parsing corner cases before depending on it); no excluded/generated targets; bounded body/field lengths; dedupe by normalized path + line + issue; limit low-signal and repeat findings; avoid making claims from unverified evidence. A source reference being valid is necessary, **not proof of semantic correctness**. Tests and human evaluation must measure false positives. GitHub `suggestion` blocks are a separate, opt-in phase: only generate when the replacement is validated against the anchored lines and supported by GitHub; otherwise provide prose guidance.

Immediately before posting, re-fetch the PR and compare its head SHA to the snapshot/diff SHA. On mismatch, do not post stale inline comments; re-run on the new head or exit with an explicit stale-review notice. Call `pulls.createReview` once with `event: COMMENT`, concise overview/coverage/limitations, and validated comments; keep the current behavior of not blocking merges. If all candidates are invalid, do not claim the change is safe: report that findings could not be published and why (without leaking sensitive content). A clean/no-findings conclusion must come from a completed investigation with recorded coverage. Handle GitHub invalid-position errors deliberately rather than dropping all feedback or blindly retrying.

Consider repeat triggers: in the first rollout, record head SHA in a review marker and avoid duplicate automated reviews for the same SHA (manual `/reviewally` can explicitly re-run). Further dedupe/resolution against human and prior bot review comments belongs with #24. Do not let a forged marker in a PR body suppress reviews; only trust bot-authored review metadata.

## Security and privacy requirements

- PR body, linked issues, discussions, source code, and tool output are untrusted. Do not treat text in them as higher-priority instructions. Model prompt policies mitigate injection but do **not** create a sandbox.
- pi SDK and custom extensions execute with the Action process's OS privileges. Keep model-callable tools minimal; verify path containment using canonical paths and prevent symlink traversal. If built-in tools cannot enforce the boundary, implement safe wrappers and/or isolate the SDK in a restricted process/container. Do not claim `read-only` means private host files or credentials cannot be read. Never expose tokens or provider keys through tool output or logs.
- Only host code calls GitHub APIs with the token. Keep app-token fallback and fork/`issue_comment` trigger permissions in scope for security tests; do not switch to `pull_request_target` or check out untrusted PR code with write credentials. Snapshot extraction needs size, entry-count, path, and expanded-size guards; existing tarball-limit checks rely on response `Content-Length` and are not sufficient by themselves.
- Pin third-party dependencies, do not load executable resources from reviewed repos, and test cleanup on failure/timeout. Full source and issue content are sent to the configured LLM provider only as required for analysis; document this accurately in README.

## Delivery sequence and tests

1. **SDK/packaging feasibility:** pin pi, prove SDK import, provider compatibility, resource lockdown and tool registration, Node 24 `dist/` execution, cleanup and install/bundle decision. Preserve CLI as a temporary rollback until parity is measured.
2. **Artifact/position validator:** typed candidates, patch-position lookup, summary vs inline rules, stale-SHA guard, mock GitHub posting tests. No agent migration needed to test these deterministically.
3. **In-repo reviewer:** restricted SDK session, bounded read/search/list tools, `submit_finding`, `finish_review`, provider capability behavior, no final-JSON parsing in agent mode. Retain standard-mode implementation.
4. **Context and quality:** attach #12 and #24 context where available; add a small sanitized fixture corpus of PR diffs with expected findings/no-findings, known false-positive cases, invalid lines, injection attempts and partial-coverage scenarios. Compare with the current CLI on the same fixtures/opt-in real PRs: valid findings, reviewer-confirmed utility, false positives, JSON/format failure rate, runtime, tokens and bundle/install overhead.
5. **Rollout:** dogfood on this repo without duplicate posting, update `README.md`, `action.yml` (`pi-version`/timeout wording if changed), examples and tests, run typecheck/lint/tests/build, commit rebuilt `dist/`, then retire `pi-args.ts`, `pi-process.ts`, `pi-output.ts` and obsolete prompt/parse branches only after success. Keep a versioned rollback option during the transition.

Success criteria: no posted comment at an invalid/stale position; no agent-mode dependence on fenced JSON extraction; no unapproved agent tool with GitHub-write or arbitrary-command capability; clean no-findings and partial reviews distinguishable; installed or bundled SDK runs on GitHub's Node 24 Action; no regression in the existing standard-mode path. Quality against humans cannot be guaranteed by schema validation alone.

## Open decisions before implementation

- Resolved: pi SDK is ESM-only and is loaded as a pinned runtime dependency outside the CommonJS `ncc` bundle.
- Host path-checked adapters wrap pi's read/grep/find/ls. Evaluate whether additional OS isolation is required for sensitive untrusted PRs; `cwd` and path checks are not an OS sandbox.
- Resolved: a dedicated `finish_review` call is mandatory for a completed SDK investigation.
- What threshold of evidence and confirmed completeness permits a positive no-findings review? Calibrate with fixtures and human review.
- What provider-specific fallback policy should apply when tool calls or structured output are unavailable? Document it without implying universal support.

## References

- [Pi SDK](https://pi.dev/docs/latest/sdk), [Pi security model](https://pi.dev/docs/latest/security), [Pi extensions/tools](https://pi.dev/docs/latest/extensions)
- [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- Existing planning issues: #10, #11, #12, #17, #24
