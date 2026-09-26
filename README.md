<p align="center">
  <img src="images/robot-mascot-squircle-clean.png" width="140" alt="ReviewAlly logo" />
</p>

<h1 align="center">ReviewAlly</h1>

<p align="center">
  <strong>AI-powered code review for your pull requests.</strong>
</p>

<p align="center">
  <a href="https://github.com/nethbotheju/reviewally/actions/workflows/build.yml"><img src="https://github.com/nethbotheju/reviewally/actions/workflows/build.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/nethbotheju/reviewally/releases"><img src="https://img.shields.io/github/v/tag/nethbotheju/reviewally?label=release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nethbotheju/reviewally?color=blue" alt="License" /></a>
  <a href="#support"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome" /></a>
</p>

<p align="center">
  <a href="https://github.com/apps/reviewally"><img src="https://img.shields.io/badge/Install-ReviewAlly_App-blue" alt="Install the ReviewAlly App" /></a>
</p>

---

ReviewAlly reads your pull request diff through the GitHub API and posts a structured review — background, per-file changes, and prioritized recommendations. It runs with your model and your API key: OpenAI, Anthropic, or any OpenAI-compatible endpoint.

## Features

- **Bring your own key:** OpenAI, Anthropic, or any OpenAI-compatible endpoint — your model, your billing.
- **Two review modes:** fast diff review, or agent mode that investigates your repo first.
- **On your terms:** trigger by label, slash command, or automatically.
- **Configured from the UI:** swap model, provider, or review mode in repository variables — no commits, no pull requests.
- **Structured reviews:** background, per-file changes, prioritized recommendations.

## Quick start

1. Install the **ReviewAlly App** on your repository or organization: [github.com/apps/reviewally](https://github.com/apps/reviewally).
2. Add one repository secret — `REVIEWALLY_API_KEY` — with your provider API key.
3. Set your provider config as repository variables under **Settings → Secrets and variables → Actions → Variables**:

   | Variable | Example value |
   | --- | --- |
   | `REVIEWALLY_API_TYPE` | `openai` |
   | `REVIEWALLY_MODEL` | `gpt-4o` |
   | `REVIEWALLY_BASE_URL` | *(only for `openai-chat-compatible` providers)* |

   This is the whole config. Model, provider, review mode — change these any time and the next review picks it up. No commit, no PR.

4. Copy the workflow below into `.github/workflows/reviewally.yml` (also in [`examples/workflow.yml`](./examples/workflow.yml)):

```yaml
name: reviewally
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled]
  issue_comment:
    types: [created]

concurrency:
  group: reviewally-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false

jobs:
  review:
    if: |
      (github.event_name == 'pull_request' &&
        (github.event.action != 'labeled' || github.event.label.name == 'reviewally'))
      || (github.event_name == 'issue_comment' &&
        startsWith(github.event.comment.body, '/reviewally') &&
        github.event.issue.pull_request != null)
    runs-on: ubuntu-latest
    permissions:
      actions: read    # lets ReviewAlly read REVIEWALLY_* repository variables
      contents: read
      pull-requests: write
    steps:
      - uses: nethbotheju/reviewally@v1
        with:
          app-token-url: https://api.reviewally.nethbotheju.dev/token
          api-key: ${{ secrets.REVIEWALLY_API_KEY }}
          # Optional: pin a setting here to override its variable for this workflow
          # api-type: openai-chat-compatible        # overrides REVIEWALLY_API_TYPE
          # base-url: https://opencode.ai/zen/go/v1 # overrides REVIEWALLY_BASE_URL
          # model: gpt-4o                           # overrides REVIEWALLY_MODEL
          # review-mode: agent                      # overrides REVIEWALLY_REVIEW_MODE
        # Paste this once; from now on change values in Settings, not here.
        env:
          REVIEWALLY_API_TYPE: ${{ vars.REVIEWALLY_API_TYPE }}
          REVIEWALLY_BASE_URL: ${{ vars.REVIEWALLY_BASE_URL }}
          REVIEWALLY_MODEL: ${{ vars.REVIEWALLY_MODEL }}
          REVIEWALLY_REVIEW_MODE: ${{ vars.REVIEWALLY_REVIEW_MODE }}
          REVIEWALLY_AUTO_REVIEW: ${{ vars.REVIEWALLY_AUTO_REVIEW }}
          REVIEWALLY_EXTRA_INSTRUCTIONS: ${{ vars.REVIEWALLY_EXTRA_INSTRUCTIONS }}
          REVIEWALLY_CONTEXT_DOCS: ${{ vars.REVIEWALLY_CONTEXT_DOCS }}
          REVIEWALLY_EXCLUDE_PATTERNS: ${{ vars.REVIEWALLY_EXCLUDE_PATTERNS }}
          REVIEWALLY_AGENT_TRACE: ${{ vars.REVIEWALLY_AGENT_TRACE }}
```

5. Open a pull request, or comment `/reviewally` on one.

The `env:` block is written once and then left alone — it just forwards your repository variables to the action. To pin a setting to the workflow instead, add it to `with:` (e.g. `model: gpt-4o`): an explicit input always overrides the variable. That's the one rule to remember: **the workflow file wins, so don't put config there unless you mean to freeze it.**

## Review modes

### Standard

One focused pass: the PR diff plus repository context (`AGENTS.md`, `CONTRIBUTING.md`, …) is sent to your model, which returns a structured review. Fast and effective for most changes.

### Agent

For deeper changes, ReviewAlly takes a snapshot of the repository at the PR head and starts the [pi coding agent SDK](https://github.com/earendil-works/pi) as the review harness. The model investigates using snapshot-confined `read`, `grep`, `find`, `ls`, plus `get_diff`, `submit_finding`, and `finish_review`. ReviewAlly validates proposed findings against the changed lines and snapshot, then posts a walkthrough with replyable inline comments. No code is changed. Large repositories automatically fall back to standard mode. Agent mode requires a model that supports tool calling; a missing `finish_review` call fails the run rather than being treated as a clean review.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-type` | yes¹ | — | `openai` \| `openai-chat-compatible` \| `anthropic` |
| `api-key` | yes | — | LLM API key (store in a secret) |
| `base-url` | only `openai-chat-compatible`¹ | provider default | API base URL override |
| `model` | yes¹ | — | Model identifier |
| `app-token-url` | no | — | ReviewAlly token endpoint; reviews post as `reviewally[bot]` |
| `github-token` | no | `${{ github.token }}` | Token for reading the PR and posting the review |
| `trigger-comment` | no | `/reviewally` | Slash command that triggers a review |
| `trigger-label` | no | `reviewally` | Label that triggers a review |
| `auto-review` | no | `false` | Also review on PR open/reopen/push |
| `review-mode` | no | `standard` | `standard` (single prompt) or `agent` (investigation loop) |
| `max-files` | no | `20` | Max changed files reviewed per run |
| `max-diff-lines` | no | `3000` | Max total added lines reviewed per run |
| `use-default-excludes` | no | `true` | Built-in excludes for lockfiles, minified files, sourcemaps |
| `agent-tarball-max-mb` | no | `200` | Max repo snapshot size before degrading to standard mode |
| `pi-version` | no | `0.87.1` | Pinned SDK version; only `0.87.1` is currently supported in agent mode |
| `pi-timeout-ms` | no | `600000` | SDK cancellation deadline; use a workflow job timeout for a hard kill |

¹ Or the matching `REVIEWALLY_*` repository variable — see below.

## Repository variables

**Set them once under Settings → Secrets and variables → Actions → Variables, then change them any time — no commits, no pull requests.** The workflow forwards each variable to the action with a one-time `env:` block (in the example above), because the workflow token is not allowed to read the variables API. Add one line per variable you use.

Resolution per setting: **workflow input > repository variable > built-in default** — an input written in the workflow always wins, so leave it out of the workflow to let the variable apply.

| Variable | Sets |
| --- | --- |
| `REVIEWALLY_API_TYPE` | LLM API protocol (`openai`, `openai-chat-compatible`, `anthropic`) |
| `REVIEWALLY_BASE_URL` | API base URL (required for `openai-chat-compatible`) |
| `REVIEWALLY_MODEL` | Model identifier |
| `REVIEWALLY_REVIEW_MODE` | `standard` or `agent` |
| `REVIEWALLY_AUTO_REVIEW` | `true` / `false` — review automatically on PR open/reopen/push |
| `REVIEWALLY_EXTRA_INSTRUCTIONS` | Extra guidance appended to the prompt |
| `REVIEWALLY_CONTEXT_DOCS` | Comma/newline-separated doc files for project guidance |
| `REVIEWALLY_EXCLUDE_PATTERNS` | Extra glob excludes (comma/newline separated) |
| `REVIEWALLY_AGENT_TRACE` | `true` (default) or `false` — log the SDK transcript, tool names/arguments and results in agent mode |

Existing workflows that explicitly pin `pi-version: 0.82.1` must remove that pin or update it to `0.87.1` for SDK agent mode. `REVIEWALLY_AGENT_TRACE` is environment-only (not a `with:` input) and defaults to on when unset or empty. Set the Actions repository variable to `false` and forward it via `env:` to disable it.

Switching providers is a pure UI operation: update the API-key secret value, then set `REVIEWALLY_API_TYPE`, `REVIEWALLY_BASE_URL`, and `REVIEWALLY_MODEL`. Unknown `REVIEWALLY_*` variables are ignored, and if variables cannot be read the run falls back to workflow inputs. Each run's summary shows the effective value and where it came from.

## Outputs

Standard reviews include the issue/background, implementation assessment, file summary, and recommendations. Agent reviews post a walkthrough with selected-file coverage, checks and limitations, plus validated inline findings. Findings include evidence and a prose suggested fix; applyable GitHub suggestion blocks and conversational replies are not yet supported.

## Security and privacy

- Your API key is only used to call your provider. Known API/GitHub tokens are masked in logs and never sent to agent tools. `REVIEWALLY_AGENT_TRACE` is **on by default**: Actions logs include PR prompts, model messages, tool arguments and text results (up to 64,000 characters per event and 2,000,000 per run). GitHub log viewers may see private source and PR content. Set `REVIEWALLY_AGENT_TRACE: 'false'` in the workflow environment to disable this; redaction cannot guarantee detection of unknown secrets embedded in repository files.
- Standard mode never clones your repository. Agent mode downloads a snapshot to the runner's temp directory and deletes it after the review. Path-checked read/search tools are not an operating-system sandbox; use trusted runner isolation for sensitive repositories.
- Review tokens are scoped to a single repository, expire in one hour, and only carry review-level permissions (`contents: read`, `pull_requests: write`, `issues: write`).
- Reviews are always advisory — ReviewAlly never requests changes or blocks merges.

## Support

Questions, ideas, or a review that missed the mark? Please [open an issue](https://github.com/nethbotheju/reviewally/issues).

## License

[MIT](./LICENSE)
