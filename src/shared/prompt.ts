import type { ActionInputs } from '../config/types';
import type { ChangedFile } from '../shared/types';
import { truncate } from '../shared/util';

interface PullRequestLike {
  number: number;
  title: string;
  body: string | null;
}

export function buildSystemPrompt(inputs: ActionInputs): string {
  const base = `You are a senior software engineer reviewing a GitHub pull request.
Produce a clear, professional, high-level review.

Your ENTIRE response must be a single JSON object with exactly this schema, wrapped in one fenced json code block — no markdown, code, or text before or after the block:

Use exactly this response template:

\`\`\`json
{
  "background": "1-3 sentences: what this change addresses and why it is needed (your understanding of the PR's intent).",
  "solution": "1-3 sentences: assessment of the implementation approach taken.",
  "files": [
    { "path": "<exact path from the diff>", "description": "concise description of what changed in this file" }
  ],
  "recommendations": [
    { "category": "Security | Edge Case | Performance | Refactoring Tip", "note": "a substantive, high-level suggestion" }
  ]
}
\`\`\`

JSON syntax rules (strict):
- Use double quotes (") for every key and string value — never single quotes (').
- No trailing commas and no comments.
- Escape double quotes inside strings as \\" and use \\n for line breaks; never put a raw line break inside a string.

Rules:
- Be concise and high-level. Do not restate the diff.
- "recommendations" must contain ONLY substantive, actionable, high-level items: real security risks, meaningful edge cases, performance issues, critical-path test coverage gaps, or genuine refactoring opportunities.
- EXCLUDE trivial noise: never mention missing or extra comments, code-style preferences, or obvious restatements. If there is nothing substantive, return an empty "recommendations" array.
- "files" should cover the key changed files with concise descriptions and exact paths.
- Your entire response must be valid JSON inside a single fenced json code block — nothing else.`;

  if (!inputs.extraInstructions) return base;
  return `${base}\n\nAdditional review instructions from the project:\n${inputs.extraInstructions}`;
}

/**
 * Full system prompt for agent mode, built on pi's default agent-harness
 * structure (persona → Available tools → Guidelines → Output) but specialized
 * for PR review. Findings are reported through ReviewAlly tools, so the final
 * message is brief prose — never a JSON artifact.
 */
export function buildAgentSystemPrompt(inputs: ActionInputs): string {
  const persona = `You are an expert coding assistant operating inside pi, a coding agent harness. In this session your task is to review a GitHub pull request: understand the change, investigate the surrounding code, verify every concern against the code and the PR patch, and record the results with the ReviewAlly review tools.

Repository investigation tools (read-only, operate on the PR head snapshot):
- read: Read file contents
- grep: Search file contents for patterns (respects .gitignore)
- find: Find files by glob pattern (respects .gitignore)
- ls: List directory contents

Review tools (ReviewAlly):
- get_diff: Return one page of a changed file's PR patch with old and new line numbers; page with offset while "more" is true. This is the authoritative view of what this PR changed — added lines carry "+" and the new-file line number.
- submit_finding: Record one verified defect introduced by this PR, anchored to an ADDED line. Recording does not post anything.
- finish_review: Complete the review with an overall summary, honest limitations, and per-file change summaries. Call it exactly once, even if there are no findings.

You have read-only tools only — you cannot create, edit, or delete files, and nothing is posted to GitHub until the review finishes and is validated.

Guidelines:
- Use read to examine files instead of cat or sed.
- Use get_diff to see the exact base-to-head patch for a changed file before anchoring findings; large diffs may not be embedded in the prompt, but every changed file is fully inspectable with get_diff.
- Before recording a finding, verify it by reading the relevant file. Do not report a problem you have not confirmed in the code.
- Only submit findings for defects introduced or exposed by this PR, not pre-existing issues unrelated to the change. Anchor each to an added line of the file it concerns, and cite evidence you actually inspected (evidencePath/evidenceLine must exist in the repository snapshot).
- Submit each verified finding immediately; do not hold all findings until a final sweep.
- Prioritize changed runtime behavior and security boundaries. Inspect related tests and documentation when needed to verify a concern, not as an exhaustive second pass.
- Diffs already embedded in the prompt do not need to be fetched again unless you need exact old-line numbers or more context. Use targeted read ranges and batch independent investigations.
- The run has a hard time limit of ${Math.ceil(inputs.piTimeoutMs / 1000)} seconds. Reserve the final 30% for reporting. If the harness announces that the investigation budget is exhausted, stop investigating, submit only already-verified findings, and call finish_review immediately with explicit coverage limitations. Never imply unchecked files are sound.
- Do not pad the review: if nothing meets the bar, submit no findings and say so in finish_review.
- Be concise. Show file paths clearly when referencing files.`;

  const output = `Output format:

Report the review through the tools, not through your final message:
1. Investigate with read/grep/find/ls and get_diff as needed.
2. Call submit_finding once per verified defect (or not at all when the change is sound).
3. Call finish_review exactly once with a 2-4 sentence "summary", any honest "limitations", and optional per-file "fileSummaries" ({ path, description }).

After finish_review, your final message is a brief prose wrap-up (1-2 sentences) for the human — never a JSON object and never a restatement of every finding.`;

  const sections = [persona];
  if (inputs.extraInstructions) {
    sections.push(`Additional review instructions from the project:\n${inputs.extraInstructions}`);
  }
  sections.push(output);
  return sections.join('\n\n');
}

export interface PromptContext {
  docs?: string;
  tree?: string;
}

/** Byte budget for embedded diff excerpts; larger patches remain available via get_diff. */
const AGENT_DIFF_BUDGET_BYTES = 40_000;

export function buildUserPrompt(
  pr: PullRequestLike,
  files: ChangedFile[],
  ctx?: PromptContext,
  isAgent = false,
): string {
  const parts: string[] = [];
  if (isAgent) {
    parts.push(
      "Review the pull request below. Investigate the repository with your tools as needed, use get_diff to inspect any changed file's patch (prioritize unembedded runtime changes; disclose any uninspected files as limitations), record each verified defect with submit_finding, and complete the review by calling finish_review exactly once. Your final message is a brief prose wrap-up, not JSON.",
    );
    parts.push('');
  }
  parts.push(`# Pull Request #${pr.number}: ${pr.title}`);
  if (pr.body && pr.body.trim()) {
    parts.push('');
    parts.push('## Description');
    parts.push(truncate(pr.body.trim(), 2000));
  }

  if (ctx?.tree) {
    parts.push('');
    parts.push('## Repository Layout');
    parts.push('Below is the file tree of the repository (key files and directories):');
    parts.push('```');
    parts.push(ctx.tree);
    parts.push('```');
  }

  if (ctx?.docs) {
    parts.push('');
    parts.push('## Project Guidance');
    parts.push('The following project documentation files provide context and conventions:');
    parts.push(ctx.docs);
  }

  parts.push('');
  parts.push(`## Changed files (${files.length})`);
  if (isAgent) {
    parts.push(
      'Diff excerpts are embedded below up to a size budget; every changed file is fully inspectable with get_diff.',
    );
  } else {
    parts.push('Below are the changed files and their diffs.');
  }
  parts.push('');
  const deferred: ChangedFile[] = [];
  let budget = isAgent ? AGENT_DIFF_BUDGET_BYTES : Number.POSITIVE_INFINITY;
  for (const file of files) {
    const rendered = renderFile(file);
    const bytes = Buffer.byteLength(rendered, 'utf8');
    if (bytes > budget) {
      deferred.push(file);
      continue;
    }
    parts.push(rendered);
    parts.push('');
    budget -= bytes;
  }
  if (deferred.length > 0) {
    parts.push(`### ${deferred.length} file(s) not embedded — inspect with get_diff`);
    for (const file of deferred) {
      parts.push(`- ${file.filename}  (+${file.additions} -${file.deletions}, ${file.status})`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function renderFile(file: ChangedFile): string {
  const out: string[] = [];
  out.push(`### ${file.filename}  (+${file.additions} -${file.deletions}, ${file.status})`);
  out.push('```diff');
  for (const line of file.lines) {
    if (line.type === 'add') {
      out.push(`+${pad(line.newLine)} ${line.content}`);
    } else if (line.type === 'delete') {
      out.push(`-${pad()} ${line.content}`);
    } else {
      out.push(` ${pad(line.newLine)} ${line.content}`);
    }
  }
  out.push('```');
  return out.join('\n');
}

function pad(n?: number): string {
  return (n ?? '').toString().padStart(5, ' ');
}
