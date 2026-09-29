import type { ChangedFile, FetchResult } from '../../shared/types';
import type { PiEvent } from './pi-types';

export const GET_DIFF_TOOL = 'get_diff';
export const SUBMIT_FINDING_TOOL = 'submit_finding';
export const FINISH_REVIEW_TOOL = 'finish_review';

export const AGENT_TOOL_NAMES = [GET_DIFF_TOOL, SUBMIT_FINDING_TOOL, FINISH_REVIEW_TOOL];

/** Host-side cap mirroring the extension; extra candidates are dropped. */
export const MAX_FINDINGS = 25;

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface AgentFinding {
  path: string;
  line: number;
  title: string;
  severity: FindingSeverity;
  impact: string;
  evidencePath: string;
  evidenceLine: number;
  evidence: string;
  suggestedFix: string;
}

export interface AgentFileSummary {
  path: string;
  description: string;
}

export interface AgentFinish {
  summary: string;
  limitations: string[];
  fileSummaries: AgentFileSummary[];
}

/** ReviewAlly tool calls collected from the pi JSONL event stream. */
export interface AgentToolCalls {
  findings: AgentFinding[];
  finish?: AgentFinish;
  /** Ordered unique paths the agent explicitly inspected via get_diff. */
  inspectedPaths: string[];
  /** Number of completed get_diff calls (including repeat pages). */
  diffCalls: number;
  /** `toolName: message` entries for tool executions that ended with an error. */
  toolErrors: string[];
  /** Tool calls that started but never completed (CLI died mid-call). */
  uncompletedCalls: number;
}

export interface DiffsPayloadLine {
  type: string;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffsPayloadFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  lines: DiffsPayloadLine[];
}

export interface DiffsPayload {
  truncated: boolean;
  totalFiles: number;
  reviewedFiles: number;
  files: DiffsPayloadFile[];
}

/** Build the diff payload the get_diff tool pages over (written to REVIEWALLY_DIFFS_FILE). */
export function buildDiffsPayload(fetch: FetchResult): DiffsPayload {
  return {
    truncated: fetch.truncated,
    totalFiles: fetch.totalFiles,
    reviewedFiles: fetch.reviewedFiles,
    files: fetch.files.map((f: ChangedFile) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      lines: f.lines.map((l) => ({
        type: l.type,
        ...(l.oldLine !== undefined ? { oldLine: l.oldLine } : {}),
        ...(l.newLine !== undefined ? { newLine: l.newLine } : {}),
        content: l.content,
      })),
    })),
  };
}

function asFinding(args: Record<string, unknown>): AgentFinding {
  return {
    path: typeof args.path === 'string' ? args.path : '',
    line: typeof args.line === 'number' ? args.line : Number.NaN,
    title: typeof args.title === 'string' ? args.title : '',
    severity: (['high', 'medium', 'low'] as const).includes(args.severity as FindingSeverity)
      ? (args.severity as FindingSeverity)
      : ('low' as FindingSeverity),
    impact: typeof args.impact === 'string' ? args.impact : '',
    evidencePath: typeof args.evidencePath === 'string' ? args.evidencePath : '',
    evidenceLine: typeof args.evidenceLine === 'number' ? args.evidenceLine : Number.NaN,
    evidence: typeof args.evidence === 'string' ? args.evidence : '',
    suggestedFix: typeof args.suggestedFix === 'string' ? args.suggestedFix : '',
  };
}

function asFinish(args: Record<string, unknown>): AgentFinish {
  const limitations = Array.isArray(args.limitations)
    ? args.limitations.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
    : [];
  const fileSummaries = Array.isArray(args.fileSummaries)
    ? args.fileSummaries
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const f = item as Record<string, unknown>;
          const path = typeof f.path === 'string' ? f.path.trim() : '';
          const description = typeof f.description === 'string' ? f.description.trim() : '';
          if (!path || !description) return null;
          return { path, description };
        })
        .filter((x): x is AgentFileSummary => x !== null)
    : [];
  return {
    summary: typeof args.summary === 'string' ? args.summary.trim() : '',
    limitations,
    fileSummaries,
  };
}

function resultText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const result = value as { content?: unknown };
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content.find(
    (c): c is { type: string; text?: string } =>
      typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
  );
  return (first?.text ?? '').trim();
}

/**
 * Collect ReviewAlly tool calls from the pi JSONL event stream. A call counts
 * only when its tool_execution_end arrived without an error; error and
 * interrupted calls are surfaced separately so an incomplete run can never
 * look like a clean review.
 */
export function collectAgentToolCalls(events: PiEvent[]): AgentToolCalls {
  const starts = new Map<string, { toolName: string; args: unknown }>();
  const completed = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  const ended = new Set<string>();
  const toolErrors: string[] = [];
  let uncompleted = 0;

  for (const e of events) {
    if (e.type === 'tool_execution_start' && typeof e.toolName === 'string') {
      if (AGENT_TOOL_NAMES.includes(e.toolName) && typeof e.toolCallId === 'string') {
        starts.set(e.toolCallId, { toolName: e.toolName, args: e.args });
      }
    } else if (e.type === 'tool_execution_end' && typeof e.toolName === 'string') {
      if (!AGENT_TOOL_NAMES.includes(e.toolName) || typeof e.toolCallId !== 'string') continue;
      const start = starts.get(e.toolCallId);
      if (!start) continue;
      ended.add(e.toolCallId);
      if (e.isError) {
        toolErrors.push(`${e.toolName}: ${truncate(resultText(e.result), 300) || 'failed'}`);
      } else if (start.args && typeof start.args === 'object') {
        completed.set(e.toolCallId, {
          toolName: e.toolName,
          args: start.args as Record<string, unknown>,
        });
      }
    }
  }

  for (const id of starts.keys()) {
    if (!ended.has(id)) uncompleted++;
  }

  const findings: AgentFinding[] = [];
  const inspectedPaths: string[] = [];
  let diffCalls = 0;
  let finish: AgentFinish | undefined;

  for (const { toolName, args } of completed.values()) {
    if (toolName === SUBMIT_FINDING_TOOL && findings.length < MAX_FINDINGS) {
      findings.push(asFinding(args));
    } else if (toolName === GET_DIFF_TOOL) {
      diffCalls++;
      const p = typeof args.path === 'string' ? args.path.trim() : '';
      if (p && !inspectedPaths.includes(p)) inspectedPaths.push(p);
    } else if (toolName === FINISH_REVIEW_TOOL) {
      finish = asFinish(args);
    }
  }

  return {
    findings,
    finish,
    inspectedPaths,
    diffCalls,
    toolErrors,
    uncompletedCalls: uncompleted,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
