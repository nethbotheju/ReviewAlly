import type { ChangedFile } from '../../shared/types';

type TypeBox = typeof import('typebox').Type;
type DefineTool = typeof import('@earendil-works/pi-coding-agent').defineTool;

export interface CandidateFinding {
  path: string;
  line: number;
  title: string;
  severity: 'high' | 'medium' | 'low';
  impact: string;
  evidencePath: string;
  evidenceLine: number;
  evidence: string;
  suggestedFix: string;
}

export interface AgentAssessment {
  summary: string;
  limitations: string[];
  fileSummaries?: Array<{ path: string; description: string }>;
}

export interface AgentInvestigation {
  findings: CandidateFinding[];
  assessment?: AgentAssessment;
  openedDiffs: string[];
  completedDiffs?: string[];
}

const MAX_FINDINGS = 12;
const MAX_DIFF_REQUESTS = 80;
const MAX_DIFF_LINES = 120;
const MAX_DIFF_BYTES = 12000;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export function createReviewToolKit(Type: TypeBox, defineTool: DefineTool, files: ChangedFile[]) {
  const changedFiles = new Map(files.map((file) => [file.filename, file]));
  const findings: CandidateFinding[] = [];
  const openedDiffs = new Set<string>();
  const completedDiffs = new Set<string>();
  let diffRequests = 0;
  let assessment: AgentAssessment | undefined;

  const getDiff = defineTool({
    name: 'get_diff',
    label: 'Get PR diff',
    description: 'Read the PR patch for one changed file with its new-file line numbers.',
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params) {
      if (++diffRequests > MAX_DIFF_REQUESTS) throw new Error('Diff request limit reached.');
      const file = changedFiles.get(params.path);
      if (!file) throw new Error('No reviewable PR patch exists for that path.');
      const offset = params.offset ?? 1;
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('Invalid diff offset.');
      const lines = file.lines;
      if (offset > lines.length) throw new Error('Diff offset exceeds the patch length.');
      openedDiffs.add(file.filename);

      const output: string[] = [];
      let bytes = 0;
      for (const item of lines.slice(offset - 1, offset - 1 + MAX_DIFF_LINES)) {
        const prefix = item.type === 'add' ? '+' : item.type === 'delete' ? '-' : ' ';
        const rendered = `${prefix} ${String(item.newLine ?? '').padStart(5)} | ${item.content}`;
        const size = Buffer.byteLength(rendered, 'utf8') + 1;
        if (bytes + size > MAX_DIFF_BYTES) break;
        bytes += size;
        output.push(rendered);
      }
      if (output.length === 0) throw new Error('Patch line exceeds the output size limit.');
      const nextOffset = offset + output.length;
      if (nextOffset > lines.length) completedDiffs.add(file.filename);
      const incomplete = lines.filter((item) => item.type === 'add').length !== file.additions;
      const notice = [
        nextOffset <= lines.length ? `More patch lines: use offset=${nextOffset}` : '',
        incomplete ? 'GitHub patch is incomplete; inline findings for this file are disabled.' : '',
      ]
        .filter(Boolean)
        .map((item) => `\n[${item}]`)
        .join('');
      return {
        content: [
          { type: 'text', text: `Diff for ${file.filename}:\n${output.join('\n')}${notice}` },
        ],
        details: undefined,
      };
    },
  });

  const submitFinding = defineTool({
    name: 'submit_finding',
    label: 'Submit candidate finding',
    description:
      'Propose a verified defect anchored to a newly added RIGHT-side line. This does not post to GitHub.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ maxLength: 500 }),
      line: Type.Integer({ minimum: 1 }),
      title: Type.String({ maxLength: 160 }),
      severity: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
      impact: Type.String({ maxLength: 1200 }),
      evidencePath: Type.String({ maxLength: 500 }),
      evidenceLine: Type.Integer({ minimum: 1 }),
      evidence: Type.String({ maxLength: 1600 }),
      suggestedFix: Type.String({ maxLength: 1200 }),
    }),
    async execute(_id, params) {
      if (assessment) throw new Error('The review has already finished.');
      if (findings.length >= MAX_FINDINGS) throw new Error('Finding limit reached.');
      const finding: CandidateFinding = params;
      if (
        ![finding.title, finding.impact, finding.evidence, finding.suggestedFix].every(nonBlank)
      ) {
        throw new Error('Finding text fields cannot be blank.');
      }
      const file = changedFiles.get(finding.path);
      if (!file?.lines.some((item) => item.type === 'add' && item.newLine === finding.line)) {
        throw new Error('Finding must be anchored to an added line in the selected PR diff.');
      }
      if (file.lines.filter((item) => item.type === 'add').length !== file.additions) {
        throw new Error('PR patch is incomplete; inline finding cannot be anchored safely.');
      }
      if (findings.some((item) => item.path === finding.path && item.line === finding.line)) {
        throw new Error('A finding has already been submitted on this line.');
      }
      findings.push({ ...finding });
      return {
        content: [{ type: 'text', text: 'Candidate recorded for host validation.' }],
        details: undefined,
      };
    },
  });

  const finishReview = defineTool({
    name: 'finish_review',
    label: 'Finish review',
    description: 'Record a concise review assessment and any limitations; does not post to GitHub.',
    executionMode: 'sequential',
    parameters: Type.Object({
      summary: Type.String({ maxLength: 1500 }),
      limitations: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 }),
      fileSummaries: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ maxLength: 500 }),
            description: Type.String({ maxLength: 300 }),
          }),
          { maxItems: 20 },
        ),
      ),
    }),
    async execute(_id, params) {
      if (assessment) throw new Error('The review has already finished.');
      const { summary, limitations, fileSummaries } = params;
      if (!nonBlank(summary) || limitations.some((item) => !nonBlank(item))) {
        throw new Error('Assessment text fields cannot be blank.');
      }
      assessment = {
        summary,
        limitations: [...limitations],
        ...(fileSummaries
          ? {
              fileSummaries: fileSummaries.filter(
                (item) => changedFiles.has(item.path) && nonBlank(item.description),
              ),
            }
          : {}),
      };
      return { content: [{ type: 'text', text: 'Assessment recorded.' }], details: undefined };
    },
  });

  return {
    tools: [getDiff, submitFinding, finishReview],
    result: (): AgentInvestigation => ({
      findings: findings.map((finding) => ({ ...finding })),
      ...(assessment
        ? {
            assessment: {
              ...assessment,
              limitations: [...assessment.limitations],
              ...(assessment.fileSummaries
                ? { fileSummaries: assessment.fileSummaries.map((item) => ({ ...item })) }
                : {}),
            },
          }
        : {}),
      openedDiffs: [...openedDiffs],
      completedDiffs: [...completedDiffs],
    }),
  };
}
