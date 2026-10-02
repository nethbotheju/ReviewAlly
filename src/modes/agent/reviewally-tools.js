/**
 * ReviewAlly pi extension: review-owned tools for agent mode.
 *
 * Loaded explicitly via `pi --extension <path>` (runs inside the pi process).
 * The PR patch data is provided by the host through REVIEWALLY_DIFFS_FILE; the
 * tool calls themselves are collected from the CLI JSONL event stream by the
 * host, which re-validates everything before posting to GitHub.
 *
 * Zero runtime dependencies: TypeBox accepts plain-object JSON schemas, so the
 * extension needs no imports beyond node builtins and can live anywhere.
 */
import * as fs from 'node:fs';

export const DIFFS_FILE_ENV = 'REVIEWALLY_DIFFS_FILE';

const PAGE_SIZE = 200;
const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 500;
const MAX_LISTED_PATHS = 50;
/** Mirrors the host validator: files larger than this skip the line-range check. */
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

let diffsCache = null;
const findings = [];
const findingKeys = new Set();
let finished = false;
let wrapUpTimer;
let finalizing = false;

function loadDiffs() {
  if (diffsCache) return diffsCache;
  const file = process.env[DIFFS_FILE_ENV];
  if (!file) {
    throw new Error(`get_diff is unavailable: ${DIFFS_FILE_ENV} is not set for this review.`);
  }
  try {
    diffsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`get_diff failed to load the review diff data: ${err.message}`);
  }
  return diffsCache;
}

function findFile(path) {
  const data = loadDiffs();
  return (data.files || []).find((f) => f.path === path) || null;
}

function renderLine(l) {
  const old = String(l.oldLine ?? '').padStart(6);
  const nw = String(l.newLine ?? '').padStart(6);
  const mark = l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' ';
  const content =
    l.content.length > MAX_LINE_CHARS ? `${l.content.slice(0, MAX_LINE_CHARS)}…` : l.content;
  return `${old} ${nw} ${mark} ${content}`;
}

/** Line count of a snapshot file, mirroring the host validator's semantics. */
function snapshotLineCount(relPath) {
  let stat;
  try {
    stat = fs.statSync(relPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) return 0;
  const content = fs.readFileSync(relPath, 'utf8');
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

/**
 * Validate evidencePath/evidenceLine at call time so the model gets an
 * actionable error and can re-submit, instead of a silent host-side rejection
 * after the run ends.
 */
function validateEvidence(params) {
  const evidencePath =
    typeof params.evidencePath === 'string' ? params.evidencePath.trim() : '';
  const evidenceLine = params.evidenceLine;
  if (!evidencePath || !Number.isInteger(evidenceLine) || evidenceLine < 1) {
    throw new Error(
      'submit_finding requires a repository-relative evidencePath and a positive integer evidenceLine.',
    );
  }

  const lines = snapshotLineCount(evidencePath);
  if (lines === null) {
    throw new Error(
      `evidence file "${evidencePath}" was not found in the repository snapshot — check the path is repository-relative and correct (e.g. "src/lib/util.ts"), then re-submit.`,
    );
  }
  if (lines > 0 && evidenceLine > lines) {
    throw new Error(
      `evidenceLine ${evidenceLine} is out of range for "${evidencePath}" (1-${lines}). ` +
        'Verify the exact line with read or grep, then re-submit the finding with the corrected evidenceLine.',
    );
  }
}

const getDiffTool = {
  name: 'get_diff',
  label: 'Get diff',
  description:
    'Return one page of this pull request patch for a changed file, with old and new line numbers per line (added lines carry the new-file line number). Page through large patches by passing offset while "more" is true.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Changed-file path exactly as listed in the review (e.g. "src/index.ts").',
      },
      offset: {
        type: 'integer',
        description: `1-based patch-line offset to resume from; omit for the first page (${PAGE_SIZE} patch lines per page).`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  async execute(_toolCallId, params) {
    const path = typeof params.path === 'string' ? params.path.trim() : '';
    if (!path) throw new Error('get_diff requires a non-empty "path".');

    const data = loadDiffs();
    const file = findFile(path);
    if (!file) {
      const known = (data.files || []).map((f) => f.path);
      const listed = known.slice(0, MAX_LISTED_PATHS).join(', ');
      const more = known.length > MAX_LISTED_PATHS ? `, … (${known.length} total)` : '';
      const truncatedNote = data.truncated
        ? ` The file selection was truncated (${data.reviewedFiles} of ${data.totalFiles} changed files are inspectable).`
        : '';
      throw new Error(
        `"${path}" is not among the changed files in this review (changed, non-excluded files only). ` +
          `Changed files: ${listed}${more}.${truncatedNote} ` +
          'For unchanged files or broader context, use read/grep on the repository snapshot instead.',
      );
    }

    const lines = file.lines || [];
    const total = lines.length;
    if (total === 0) {
      throw new Error(`The patch for "${path}" is empty or incomplete in the review data.`);
    }

    const offset = params.offset === undefined ? 1 : params.offset;
    if (!Number.isInteger(offset) || offset < 1 || offset > total) {
      throw new Error(
        `Invalid offset ${JSON.stringify(params.offset)} for "${path}": must be an integer between 1 and ${total} (the patch has ${total} lines).`,
      );
    }

    const end = Math.min(offset - 1 + PAGE_SIZE, total);
    const page = lines.slice(offset - 1, end).map(renderLine).join('\n');
    const more = end < total;
    return {
      details: undefined,
      content: [
        {
          type: 'text',
          text:
            `${path} — ${file.status}, +${file.additions} -${file.deletions}, ` +
            `patch lines ${offset}-${end} of ${total}\n` +
            'Columns: old-line new-line change content (blank = not present on that side)\n' +
            `${page}\n` +
            (more
              ? `more: yes — call get_diff again with path="${path}" offset=${end + 1}`
              : 'more: no — end of patch'),
        },
      ],
    };
  },
};

const submitFindingTool = {
  name: 'submit_finding',
  label: 'Submit finding',
  description:
    'Record one candidate defect introduced by this pull request, anchored to an ADDED line (new-file line number) of a changed file. Only lines with a "+" in get_diff output are valid anchors. Recording does not post anything; the host validates before publishing.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Changed-file path containing the defect (must match get_diff output).',
      },
      line: {
        type: 'integer',
        description: 'New-file line number of an ADDED line to anchor the finding to.',
      },
      title: { type: 'string', description: 'One-line summary of the defect (max ~200 chars).' },
      severity: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How much this matters if shipped: high, medium, or low.',
      },
      impact: {
        type: 'string',
        description: 'What breaks or degrades if this ships (1-3 sentences).',
      },
      evidencePath: {
        type: 'string',
        description:
          'Repository file you inspected that supports the claim (repository-relative, must exist in the snapshot).',
      },
      evidenceLine: {
        type: 'integer',
        description:
          'Line number in evidencePath that supports the claim (must be within the file — verify with read/grep before submitting).',
      },
      evidence: {
        type: 'string',
        description: 'Why the cited line(s) demonstrate the problem.',
      },
      suggestedFix: { type: 'string', description: 'Concrete suggested fix (1-3 sentences).' },
    },
    required: [
      'path',
      'line',
      'title',
      'severity',
      'impact',
      'evidencePath',
      'evidenceLine',
      'evidence',
      'suggestedFix',
    ],
    additionalProperties: false,
  },

  async execute(_toolCallId, params) {
    if (finished) throw new Error('The review is already complete; no more findings can be submitted.');
    if (findings.length >= MAX_FINDINGS) {
      throw new Error(`Finding limit reached (${MAX_FINDINGS}); do not submit more.`);
    }

    const path = typeof params.path === 'string' ? params.path.trim() : '';
    const file = findFile(path);
    if (!file) {
      throw new Error(
        `"${path}" is not among the changed files in this review — findings must anchor to a changed file. ` +
          'Call get_diff for the file to confirm the exact path and added-line numbers, then re-submit.',
      );
    }

    const line = params.line;
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`Invalid line ${JSON.stringify(line)}: must be a positive integer.`);
    }

    const anchor = (file.lines || []).find((l) => l.type === 'add' && l.newLine === line);
    if (!anchor) {
      throw new Error(
        `Line ${line} of "${path}" is not an added line in this PR — findings must anchor to added ("+") lines. ` +
          `Call get_diff for "${path}", pick the new-file line number of a "+" line, and re-submit.`,
      );
    }

    validateEvidence(params);

    const key = `${path}:${line}`;
    if (findingKeys.has(key)) {
      throw new Error(
        `A finding is already recorded at ${key}; combine them or pick a different anchor line.`,
      );
    }

    findings.push(params);
    findingKeys.add(key);
    return {
      details: undefined,
      content: [
        {
          type: 'text',
          text: `Recorded finding #${findings.length} at ${key} (${params.severity}). This records a candidate only — nothing is posted yet. Call finish_review when the review is complete.`,
        },
      ],
    };
  },
};

const finishReviewTool = {
  name: 'finish_review',
  label: 'Finish review',
  description:
    'Complete the review. Call exactly once, after all investigation and findings. Required even when no findings were submitted.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Overall assessment of the change (2-4 sentences).',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Honest coverage limitations (areas not verified, tooling gaps, etc.).',
      },
      fileSummaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Changed-file path.' },
            description: { type: 'string', description: 'What changed in this file (one sentence).' },
          },
          required: ['path', 'description'],
          additionalProperties: false,
        },
        description: 'Optional per-file change summaries for the changed files.',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },

  async execute(_toolCallId, params) {
    if (finished) {
      throw new Error('finish_review was already called; the review is complete.');
    }
    finished = true;
    clearTimeout(wrapUpTimer);
    return {
      details: undefined,
      content: [
        {
          type: 'text',
          text: `Review finished: ${findings.length} finding(s) recorded, summary accepted. You may now give a brief closing message (no JSON required).`,
        },
      ],
    };
  },
};

export default function (pi) {
  pi.registerTool(getDiffTool);
  pi.registerTool(submitFindingTool);
  pi.registerTool(finishReviewTool);

  pi.on('session_start', () => {
    const timeoutMs = Number(process.env.REVIEWALLY_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    wrapUpTimer = setTimeout(() => {
      if (finished || finalizing) return;
      finalizing = true;
      pi.setActiveTools(['submit_finding', 'finish_review']);
      pi.setThinkingLevel('low');
      pi.sendMessage(
        {
          customType: 'reviewally_budget',
          content:
            'The investigation budget is exhausted. Stop investigating now. Submit only findings you have already verified, then call finish_review immediately. Include the time budget and uninspected areas in limitations; do not claim full coverage. Do not give a prose-only answer instead of calling finish_review.',
          display: false,
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
    }, Math.floor(timeoutMs * 0.7));
    wrapUpTimer.unref();
  });
  pi.on('agent_settled', () => clearTimeout(wrapUpTimer));
  pi.on('session_shutdown', () => clearTimeout(wrapUpTimer));
}
