# ReviewAlly Token Minter

Holds the ReviewAlly GitHub App credentials and mints short-lived (1 hour),
repo-scoped installation tokens for the action's `app-token-url` input.

```
POST /token   { "repo": "owner/name" }   Authorization: Bearer <workflow GITHUB_TOKEN or user token>
-> 200 { "token": "...", "expires_at": "..." }
   401 caller token invalid   404 App not installed on the repo   429 rate limited
```

Only workflow `GITHUB_TOKEN`s (server-to-server `ghs_` tokens) and user
tokens (`gho_`, `ghp_`, fine-grained `github_pat_`) are accepted. Workflow
tokens pass repo-access validation only; user tokens must additionally have
**push access** to the requested repo, so only collaborators can mint.

## Secrets

The Worker reads two secrets at runtime; both values come from the ReviewAlly
GitHub App settings page.

```bash
wrangler secret put APP_ID                  # numeric App ID
wrangler secret put GITHUB_APP_PRIVATE_KEY  # full contents of the .pem file
```

## Deploy

Deploys from this directory using `wrangler.toml`, which routes the Worker at
`api.reviewally.nethbotheju.dev`.

```bash
wrangler deploy
```
