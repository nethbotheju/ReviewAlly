import { truncate } from '../shared/util';
import type {
  ActionInputs,
  ApiType,
  ConfigKnob,
  ConfigSource,
  ConfigSources,
  PiLogLevel,
  RawActionInputs,
  ResolvedConfig,
  ReviewMode,
} from './types';

const VALID_API_TYPES: ReadonlySet<string> = new Set<ApiType>([
  'openai',
  'openai-chat-compatible',
  'anthropic',
]);
const VALID_REVIEW_MODES: ReadonlySet<string> = new Set<ReviewMode>(['standard', 'agent']);
const DEFAULT_CONTEXT_DOCS = ['AGENTS.md', '.reviewally.md', 'CONTRIBUTING.md'];

export const CONFIG_VARIABLES = {
  apiType: 'REVIEWALLY_API_TYPE',
  baseUrl: 'REVIEWALLY_BASE_URL',
  model: 'REVIEWALLY_MODEL',
  reviewMode: 'REVIEWALLY_REVIEW_MODE',
  autoReview: 'REVIEWALLY_AUTO_REVIEW',
  extraInstructions: 'REVIEWALLY_EXTRA_INSTRUCTIONS',
  contextDocs: 'REVIEWALLY_CONTEXT_DOCS',
  excludePatterns: 'REVIEWALLY_EXCLUDE_PATTERNS',
} as const;

const KNOWN_VARIABLES: ReadonlySet<string> = new Set<string>(Object.values(CONFIG_VARIABLES));

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * REVIEWALLY_* config forwarded from the workflow's `vars` context, e.g.
 * `env: { REVIEWALLY_MODEL: ${{ vars.REVIEWALLY_MODEL }} }`. The REST variables
 * API needs a Variables(read) App/PAT token, so the workflow token cannot use it.
 */
export function repoVariablesFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const vars = new Map<string, string>();
  for (const name of KNOWN_VARIABLES) {
    const value = env[name]?.trim();
    if (value) vars.set(name, value);
  }
  return vars;
}

interface Pick {
  value?: string;
  source: ConfigSource;
}

function pick(raw: string | undefined, vars: Map<string, string>, variableName: string): Pick {
  if (raw !== undefined) return { value: raw, source: 'workflow input' };
  const value = vars.get(variableName)?.trim();
  if (value) return { value, source: 'repo variable' };
  return { source: 'default' };
}

function fromVariable(source: ConfigSource, variableName: string): string {
  return source === 'repo variable' ? ` (from repository variable ${variableName})` : '';
}

/** Resolve the config chain (workflow input > repo variable > default) and validate the result. */
export function resolveInputs(raw: RawActionInputs, vars: Map<string, string>): ResolvedConfig {
  const sources: ConfigSources = {};

  const apiTypePick = pick(raw.apiType, vars, CONFIG_VARIABLES.apiType);
  const apiType = apiTypePick.value;
  if (!apiType) {
    throw new Error(
      `'api-type' is required — set the workflow input or the ${CONFIG_VARIABLES.apiType} repository variable.`,
    );
  }
  if (!VALID_API_TYPES.has(apiType)) {
    throw new Error(
      `Invalid api-type '${apiType}'${fromVariable(apiTypePick.source, CONFIG_VARIABLES.apiType)}. Must be one of: ${[...VALID_API_TYPES].join(', ')}`,
    );
  }
  sources.apiType = apiTypePick.source;

  const baseUrlPick = pick(raw.baseUrl, vars, CONFIG_VARIABLES.baseUrl);
  sources.baseUrl = baseUrlPick.source;
  const baseUrl = baseUrlPick.value;

  if (apiType === 'openai-chat-compatible' && !baseUrl) {
    throw new Error(
      `'base-url' is required when api-type is 'openai-chat-compatible' — set the workflow input or the ${CONFIG_VARIABLES.baseUrl} repository variable.`,
    );
  }

  const modelPick = pick(raw.model, vars, CONFIG_VARIABLES.model);
  if (!modelPick.value) {
    throw new Error(
      `'model' is required — set the workflow input or the ${CONFIG_VARIABLES.model} repository variable.`,
    );
  }
  sources.model = modelPick.source;

  const reviewModePick = pick(raw.reviewMode, vars, CONFIG_VARIABLES.reviewMode);
  const reviewMode = (reviewModePick.value ?? 'standard').toLowerCase();
  if (!VALID_REVIEW_MODES.has(reviewMode)) {
    throw new Error(
      `Invalid review-mode '${reviewModePick.value}'${fromVariable(reviewModePick.source, CONFIG_VARIABLES.reviewMode)}. Must be one of: ${[...VALID_REVIEW_MODES].join(', ')}`,
    );
  }
  sources.reviewMode = reviewModePick.source;

  const autoReviewPick = pick(raw.autoReview, vars, CONFIG_VARIABLES.autoReview);
  const autoReviewRaw = (autoReviewPick.value ?? 'false').toLowerCase();
  if (autoReviewRaw !== 'true' && autoReviewRaw !== 'false') {
    throw new Error(
      `Invalid auto-review '${autoReviewPick.value}'${fromVariable(autoReviewPick.source, CONFIG_VARIABLES.autoReview)}. Must be 'true' or 'false'.`,
    );
  }
  sources.autoReview = autoReviewPick.source;

  const extraInstructionsPick = pick(undefined, vars, CONFIG_VARIABLES.extraInstructions);
  sources.extraInstructions = extraInstructionsPick.source;
  const contextDocsPick = pick(undefined, vars, CONFIG_VARIABLES.contextDocs);
  sources.contextDocs = contextDocsPick.source;
  const excludePatternsPick = pick(undefined, vars, CONFIG_VARIABLES.excludePatterns);
  sources.excludePatterns = excludePatternsPick.source;

  const contextDocs = contextDocsPick.value ? parseList(contextDocsPick.value) : [];
  const excludePatterns = excludePatternsPick.value ? parseList(excludePatternsPick.value) : [];

  const inputs: ActionInputs = {
    apiType: apiType as ApiType,
    apiKey: raw.apiKey,
    baseUrl,
    model: modelPick.value,
    githubToken: raw.githubToken,
    appTokenUrl: raw.appTokenUrl,
    triggerComment: raw.triggerComment,
    triggerLabel: raw.triggerLabel,
    autoReview: autoReviewRaw === 'true',
    maxFiles: raw.maxFiles,
    maxDiffLines: raw.maxDiffLines,
    excludePatterns,
    useDefaultExcludes: raw.useDefaultExcludes,
    extraInstructions: extraInstructionsPick.value,
    reviewMode: reviewMode as ReviewMode,
    agentTarballMaxMb: raw.agentTarballMaxMb,
    contextDocs: contextDocs.length > 0 ? contextDocs : DEFAULT_CONTEXT_DOCS,
    piVersion: raw.piVersion,
    piTimeoutMs: raw.piTimeoutMs,
    piLog: (raw.piLog as PiLogLevel | undefined) ?? 'compact',
  };

  return { inputs, sources };
}

const SUMMARY_KNOBS: {
  key: ConfigKnob;
  label: string;
  render: (inputs: ActionInputs) => string;
}[] = [
  { key: 'apiType', label: 'api-type', render: (i) => i.apiType },
  { key: 'baseUrl', label: 'base-url', render: (i) => i.baseUrl ?? '(none)' },
  { key: 'model', label: 'model', render: (i) => i.model },
  { key: 'reviewMode', label: 'review-mode', render: (i) => i.reviewMode },
  { key: 'autoReview', label: 'auto-review', render: (i) => (i.autoReview ? 'true' : 'false') },
  {
    key: 'extraInstructions',
    label: 'extra-instructions',
    render: (i) => i.extraInstructions ?? '(none)',
  },
  { key: 'contextDocs', label: 'context-docs', render: (i) => i.contextDocs.join(', ') },
  {
    key: 'excludePatterns',
    label: 'exclude-patterns',
    render: (i) => (i.excludePatterns.length > 0 ? i.excludePatterns.join(', ') : '(none)'),
  },
];

/** One row per configurable knob: value + where it came from. */
export function configSummaryRows(config: ResolvedConfig): string[][] {
  return [
    ['Setting', 'Value', 'Source'],
    ...SUMMARY_KNOBS.map(({ key, label, render }) => [
      label,
      truncate(render(config.inputs).replace(/\s+/g, ' ').trim(), 60),
      config.sources[key] ?? 'default',
    ]),
  ];
}
