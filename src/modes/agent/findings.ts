import * as fs from 'node:fs';
import type { RepoRoot } from '../../config/types';
import type { FetchResult, ReviewComment } from '../../shared/types';
import type { AgentInvestigation, CandidateFinding } from './review-tools';
import { containedPath } from './sandbox-tools';

export interface ValidatedReview {
  comments: ReviewComment[];
  rejected: Array<{ path: string; line: number; reason: string }>;
}

const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

function validateFinding(
  finding: CandidateFinding,
  files: FetchResult['files'],
  root: RepoRoot,
): ReviewComment {
  const file = files.find((candidate) => candidate.filename === finding.path);
  if (!file || !Number.isSafeInteger(finding.line) || finding.line < 1) {
    throw new Error('Path or new-file line is not in the selected diff.');
  }
  const added = file.lines.find((item) => item.type === 'add' && item.newLine === finding.line);
  if (!added) throw new Error('Anchor is not an added RIGHT-side line.');
  if (file.lines.filter((item) => item.type === 'add').length !== file.additions) {
    throw new Error('PR patch is incomplete; cannot safely anchor inline findings.');
  }
  const checks = [
    [finding.title, 160],
    [finding.impact, 1200],
    [finding.evidence, 1600],
    [finding.suggestedFix, 1200],
  ] as const;
  if (
    checks.some(
      ([value, limit]) => typeof value !== 'string' || !value.trim() || value.length > limit,
    )
  ) {
    throw new Error('Finding text is missing or exceeds the field limit.');
  }
  if (!['high', 'medium', 'low'].includes(finding.severity)) {
    throw new Error('Finding severity is invalid.');
  }
  if (!Number.isSafeInteger(finding.evidenceLine) || finding.evidenceLine < 1) {
    throw new Error('Evidence line is invalid.');
  }

  const anchorPath = containedPath(root.path, file.filename);
  const evidencePath = containedPath(root.path, finding.evidencePath);
  for (const source of [anchorPath, evidencePath]) {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error('Evidence or anchor is not a readable source file within the size limit.');
    }
  }
  const actualLine = fs.readFileSync(anchorPath, 'utf8').split(/\r?\n/)[finding.line - 1];
  if (actualLine !== added.content) {
    throw new Error('Added line does not match the reviewed head snapshot.');
  }
  const evidenceLine = fs.readFileSync(evidencePath, 'utf8').split(/\r?\n/)[
    finding.evidenceLine - 1
  ];
  if (!evidenceLine?.trim()) throw new Error('Evidence does not reference a nonempty source line.');

  const title = finding.title.trim();
  const evidence = finding.evidence.trim();
  const body = [
    `**${finding.severity.toUpperCase()}: ${title}**`,
    '',
    finding.impact.trim(),
    '',
    `Evidence: \`${finding.evidencePath.replace(/`/g, '\\`')}:${finding.evidenceLine}\` — ${evidence}`,
    '',
    `Suggested fix: ${finding.suggestedFix.trim()}`,
  ].join('\n');
  return { path: file.filename, line: finding.line, side: 'RIGHT', body };
}

export function validateAgentFindings(
  investigation: AgentInvestigation,
  fetchResult: FetchResult,
  root: RepoRoot,
): ValidatedReview {
  const comments: ReviewComment[] = [];
  const rejected: ValidatedReview['rejected'] = [];
  const locations = new Set<string>();
  for (const candidate of investigation.findings.slice(0, 12)) {
    try {
      const comment = validateFinding(candidate, fetchResult.files, root);
      const location = `${comment.path}\0${comment.line}`;
      if (locations.has(location)) throw new Error('Duplicate finding at this diff location.');
      locations.add(location);
      comments.push(comment);
    } catch (err) {
      rejected.push({
        path: candidate.path,
        line: candidate.line,
        reason: err instanceof Error ? err.message : 'Unknown validation error.',
      });
    }
  }
  if (investigation.findings.length > 12) {
    rejected.push({ path: '', line: 0, reason: 'Finding limit exceeded.' });
  }
  return { comments, rejected };
}
