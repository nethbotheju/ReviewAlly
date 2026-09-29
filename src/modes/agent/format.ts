import type { ChangedFile, ReviewComment } from '../../shared/types';
import { truncate } from '../../shared/util';
import type { AgentFinding, AgentFinish } from './tools';
import type { RejectedFinding } from './validate';

const CHANGE_TYPE: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  renamed: 'Renamed',
  copied: 'Copied',
  changed: 'Changed',
};

const SEVERITY_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export type AgentReviewStatus = 'completed' | 'partial' | 'stale';

export interface AgentReviewFormatInput {
  status: AgentReviewStatus;
  finish?: AgentFinish;
  validFindings: AgentFinding[];
  rejected: RejectedFinding[];
  capped: boolean;
  files: ChangedFile[];
  inspectedPaths: string[];
  selectionTruncated: boolean;
  truncatedReason?: string;
  toolErrors: string[];
  uncompletedCalls: number;
  headSha: string;
  /** Inline findings are only posted when the reviewed head is still current. */
  postInline: boolean;
}

/** Format the agent-mode review: top-level body + one inline comment per finding. */
export function formatAgentReview(input: AgentReviewFormatInput): {
  body: string;
  comments: ReviewComment[];
} {
  const out: string[] = [];
  out.push('### 🤖 ReviewAlly agent review', '');
  out.push(statusLine(input), '');

  out.push('<details>', '<summary>Review walkthrough</summary>', '');

  out.push('#### Changed files', '');
  out.push('| File | Change | Diff inspected | Summary |');
  out.push('| :--- | :--- | :--- | :--- |');
  const summaries = new Map(
    (input.finish?.fileSummaries ?? []).map((f) => [f.path, f.description]),
  );
  const inspected = new Set(input.inspectedPaths);
  for (const f of input.files) {
    const changeType = CHANGE_TYPE[f.status] ?? capitalize(f.status);
    const wasInspected = inspected.has(f.filename) ? 'yes' : '—';
    const description = summaries.get(f.filename)?.trim() || `+${f.additions} -${f.deletions}`;
    out.push(
      `| \`${cell(f.filename)}\` | ${changeType} | ${wasInspected} | ${cell(truncate(description, 400))} |`,
    );
  }
  out.push('');

  out.push('#### Diff inspection', '');
  const inspectedCount = input.files.filter((f) => inspected.has(f.filename)).length;
  out.push(
    `${inspectedCount} of ${input.files.length} reviewed file patches were explicitly ` +
      `inspected via \`get_diff\`.`,
  );
  if (input.selectionTruncated) {
    out.push(
      `_Incomplete coverage: the file selection was truncated (${input.truncatedReason ?? 'limits reached'})._`,
    );
  }
  out.push('');

  out.push('#### Assessment', '');
  out.push(
    input.finish?.summary
      ? truncate(inline(input.finish.summary), 2000)
      : '_No summary recorded — the review did not complete._',
    '',
  );

  out.push('#### Limitations', '');
  const limitations = (input.finish?.limitations ?? []).map((l) => truncate(inline(l), 500));
  if (limitations.length === 0) {
    out.push('_None recorded._');
  } else {
    for (const l of limitations) out.push(`- ${l}`);
  }
  out.push('');

  if (input.rejected.length > 0 || input.toolErrors.length > 0 || input.capped) {
    out.push('#### Not posted', '');
    for (const r of input.rejected) {
      const loc = r.line !== undefined ? `:${r.line}` : '';
      out.push(`- Rejected candidate \`${cell(r.path)}${loc}\` — ${cell(truncate(r.reason, 300))}`);
    }
    for (const e of input.toolErrors) out.push(`- Tool error: ${cell(truncate(e, 300))}`);
    if (input.capped) out.push('- Additional candidates were dropped (finding limit reached).');
    out.push('');
  }

  out.push(`**Reviewed head:** \`${input.headSha}\``, '');
  out.push('</details>', '');
  out.push('---', '_Automated review using ReviewAlly._');

  const comments: ReviewComment[] = input.postInline
    ? input.validFindings.map((f) => ({
        path: f.path,
        line: f.line,
        side: 'RIGHT' as const,
        body: formatFindingComment(f),
      }))
    : [];

  return { body: out.join('\n'), comments };
}

/** Markdown body for one inline finding comment. */
export function formatFindingComment(f: AgentFinding): string {
  const severity = SEVERITY_LABEL[f.severity] ?? capitalize(f.severity);
  return [
    `**[${severity}] ${truncate(f.title.trim(), 200)}**`,
    '',
    `**Impact:** ${truncate(inline(f.impact), 1200)}`,
    '',
    `**Evidence** \`${f.evidencePath}:${f.evidenceLine}\``,
    `> ${truncate(inline(f.evidence), 1200)}`,
    '',
    `**Suggested fix:** ${truncate(inline(f.suggestedFix), 1200)}`,
  ].join('\n');
}

function statusLine(input: AgentReviewFormatInput): string {
  const n = input.postInline ? input.validFindings.length : 0;
  if (input.status === 'stale') {
    return (
      `**Partial review — the PR head moved.** This review covers \`${input.headSha}\`; ` +
      'the branch has advanced since. No inline findings were posted.'
    );
  }
  if (input.status === 'partial') {
    const reasons: string[] = [];
    if (!input.finish) reasons.push('the agent did not call finish_review');
    if (input.uncompletedCalls > 0) {
      reasons.push(`${input.uncompletedCalls} tool call(s) were interrupted`);
    }
    const findingsNote =
      n > 0
        ? ` ${n} finding(s) met the bar and are posted inline; treat coverage as incomplete.`
        : '';
    return `**Partial review** — ${reasons.join('; ') || 'the run ended early'}.${findingsNote}`;
  }
  if (n === 0) {
    return (
      '**Completed — no findings.** Nothing met the evidence bar for an inline comment; ' +
      'see the walkthrough for coverage and limitations.'
    );
  }
  return `**Completed** — ${n} finding(s) posted as inline review comments below. Reply on any thread to discuss.`;
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function inline(text: string): string {
  return text.replace(/\r?\n/g, ' ').trim();
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Modified';
}
