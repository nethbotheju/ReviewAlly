// ReviewAlly token minter: exchanges a workflow GITHUB_TOKEN for a short-lived,
// repo-scoped ReviewAlly App installation token.
//
// POST /token  { "repo": "owner/name" }
// -> 200 { "token", "expires_at" } | 401 bad caller | 404 App not installed | 429 rate limited

import { pemToDer, toPkcs8 } from './crypto.js';

const API = 'https://api.github.com';
const TOKEN_TTL_SECONDS = 3600;
const PER_REPO_HOURLY_LIMIT = 30;
const JWT_CACHE_MS = 120_000;

let cachedKey = null;
let cachedJwt = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/token') {
      return reply(405, { error: 'POST /token only' });
    }

    const workflowToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!workflowToken) return reply(401, { error: 'missing bearer token' });

    let repo = '';
    try {
      repo = String(((await request.json()) || {}).repo || '');
    } catch {
      /* fall through to validation below */
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return reply(400, { error: 'invalid repo; expected "owner/name"' });
    }

    // Workflow GITHUB_TOKENs (server-to-server ghs_) and user tokens (gho_,
    // ghp_, github_pat_) may mint; user tokens additionally require push
    // access to the repo.
    const isWorkflowToken = /^ghs_/.test(workflowToken);
    const isUserToken = /^(gho_|ghp_|github_pat_)/.test(workflowToken);
    if (!isWorkflowToken && !isUserToken) {
      return reply(401, { error: 'only workflow GITHUB_TOKENs or user tokens may mint' });
    }

    // Validate the caller's token can actually access this repo.
    const check = await gh(`/repos/${repo}`, `Bearer ${workflowToken}`);
    if (check.status !== 200) {
      console.error(`repo validation failed with ${check.status}`);
      return reply(401, { error: 'token is not valid for this repo' });
    }

    // Anyone can hold a user token; require collaborator-level write access
    // before minting on their behalf.
    if (isUserToken) {
      const perms = ((await check.json().catch(() => null)) || {}).permissions || {};
      if (perms.push !== true) {
        return reply(401, { error: 'user token does not have push access to this repo' });
      }
    }

    // Count only validated callers.
    if (!rateLimit(repo)) return reply(429, { error: 'rate limit exceeded, retry later' });

    let jwt;
    try {
      jwt = await appJwt(env);
    } catch (e) {
      console.error(`key import failed: ${e.message}`);
      return reply(500, { error: 'bad GITHUB_APP_PRIVATE_KEY: ' + e.message });
    }

    const inst = await gh(`/repos/${repo}/installation`, `Bearer ${jwt}`);
    if (inst.status !== 200) {
      return reply(404, { error: 'ReviewAlly is not installed on this repo' });
    }
    const installationId = (await inst.json()).id;

    const name = repo.split('/')[1];
    const mint = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'reviewally-minter',
      },
      body: JSON.stringify({
        repositories: [name],
        permissions: { contents: 'read', pull_requests: 'write', issues: 'write' },
      }),
    });
    if (!mint.ok) {
      console.error(`mint failed: ${mint.status}`);
      return reply(502, { error: 'failed to mint installation token' });
    }
    const out = await mint.json();
    return reply(200, { token: out.token, expires_at: out.expires_at });
  },
};

async function gh(path, auth) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: auth,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'reviewally-minter',
    },
  });
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Best-effort per-isolate rate limit.
const hits = new Map();
function rateLimit(repo) {
  const now = Date.now();
  for (const [k, t] of hits) if (now - t[0] > 3_600_000) hits.delete(k);
  const t = hits.get(repo) || [now, 0];
  t[1] += 1;
  hits.set(repo, t);
  return t[1] <= PER_REPO_HOURLY_LIMIT;
}

async function appJwt(env) {
  const now = Date.now();
  if (cachedJwt && now < cachedJwt.expMs) return cachedJwt.value;
  const appId = env.APP_ID;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ iat: iat - 60, exp: iat + 180, iss: appId }));
  const data = `${header}.${payload}`;
  const key = await importKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes(data));
  const jwt = `${data}.${b64urlBytes(sig)}`;
  cachedJwt = { value: jwt, expMs: now + JWT_CACHE_MS };
  return jwt;
}

async function importKey(pem) {
  if (cachedKey) return cachedKey;
  const der = pemToDer(pem);
  try {
    cachedKey = await crypto.subtle.importKey(
      'pkcs8',
      toPkcs8(der),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new Error('key structure rejected — content is malformed or mixed up');
  }
  return cachedKey;
}

function bytes(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlBytes(buf) {
  let bin = '';
  const arr = new Uint8Array(buf);
  for (const b of arr) bin += String.fromCharCode(b);
  return b64url(bin);
}
