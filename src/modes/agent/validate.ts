import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChangedFile } from '../../shared/types';
import type { AgentFinding, AgentToolCalls } from './tools';
import { MAX_FINDINGS } from './tools';

/** Upper size for reading an evidence file; larger files skip the line-range check. */
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export interface RejectedFinding {
  path: string;
  line: number | undefined;
  title: string;
  reason: string;
}

export interface AgentValidation {
  /** Findings that passed every check, in submission order. */
  valid: AgentFinding[];
  /** Findings rejected by host validation, with reasons for the walkthrough. */
  rejected: RejectedFinding[];
  /** True when more candidates arrived than the cap allows. */
  capped: boolean;
}

const isNonEmptyString = (v: string): boolean => v.trim().length > 0;

function isSafeRepoPath(p: string): boolean {
  if (!p || path.isAbsolute(p) || p.includes('\\') || p.includes('\0')) return false;
  const normalized = path.posix.normalize(p.replace(/^\/+/, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return false;
  }
  return normalized === p && !normalized.startsWith('/');
}

function fileLineCount(absPath: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) return null;
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    if (content.length === 0) return 0;
    return content.split('\n').length;
  } catch {
    return null;
  }
}

/**
 * Host-side validation of collected tool-call findings against the selected PR
 * patches and the head snapshot. The extension already checked most of this at
 * call time; everything is re-checked here because the event stream, not the
 * tool result, is the source of truth.
 */
export function validateAgentFindings(
  toolCalls: AgentToolCalls,
  files: ChangedFile[],
  snapshotRoot: string,
): AgentValidation {
  const valid: AgentFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const seen = new Set<string>();
  const byPath = new Map(files.map((f) => [f.filename, f]));

  const candidates =
    toolCalls.findings.length > MAX_FINDINGS
      ? toolCalls.findings.slice(0, MAX_FINDINGS)
      : toolCalls.findings;
  const capped = toolCalls.findings.length > MAX_FINDINGS;

  const reject = (f: AgentFinding, reason: string) => {
    rejected.push({
      path: f.path || '(missing path)',
      line: Number.isInteger(f.line) ? f.line : undefined,
      title: f.title || '(missing title)',
      reason,
    });
  };

  for (const f of candidates) {
    const rejectReason =
      !isNonEmptyString(f.path) ||
      !Number.isInteger(f.line) ||
      f.line < 1 ||
      !isNonEmptyString(f.title) ||
      !isNonEmptyString(f.impact) ||
      !isNonEmptyString(f.evidencePath) ||
      !Number.isInteger(f.evidenceLine) ||
      f.evidenceLine < 1 ||
      !isNonEmptyString(f.evidence) ||
      !isNonEmptyString(f.suggestedFix)
        ? 'invalid or missing fields'
        : null;
    if (rejectReason) {
      reject(f, rejectReason);
      continue;
    }

    const file = byPath.get(f.path);
    if (!file) {
      reject(f, 'path is not among the files selected for this review');
      continue;
    }

    const anchor = file.lines.some((l) => l.type === 'add' && l.newLine === f.line);
    if (!anchor) {
      reject(f, `line ${f.line} is not an added line in the PR patch for ${f.path}`);
      continue;
    }

    const key = `${f.path}:${f.line}`;
    if (seen.has(key)) {
      reject(f, 'duplicate location — already recorded');
      continue;
    }

    if (!isSafeRepoPath(f.evidencePath)) {
      reject(f, `evidence path "${f.evidencePath}" is not a safe repository-relative path`);
      continue;
    }
    const evidenceAbs = path.join(snapshotRoot, f.evidencePath);
    const lines = fileLineCount(evidenceAbs);
    if (lines === null) {
      reject(f, `evidence file "${f.evidencePath}" not found in the head snapshot (or unreadable)`);
      continue;
    }
    if (lines > 0 && f.evidenceLine > lines) {
      reject(
        f,
        `evidence line ${f.evidenceLine} is out of range for ${f.evidencePath} (${lines} lines)`,
      );
      continue;
    }

    seen.add(key);
    valid.push(f);
  }

  return { valid, rejected, capped };
}
