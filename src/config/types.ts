/** Action configuration types + agent runtime types. */

export type ApiType = 'openai' | 'openai-chat-compatible' | 'anthropic';
export type ReviewMode = 'standard' | 'agent';
export type PiLogLevel = 'off' | 'compact' | 'full';
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ActionInputs {
  apiType: ApiType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  githubToken: string;
  appTokenUrl?: string;
  triggerComment: string;
  triggerLabel: string;
  autoReview: boolean;
  maxFiles: number;
  maxDiffLines: number;
  excludePatterns: string[];
  useDefaultExcludes: boolean;
  extraInstructions?: string;
  // Agent mode
  reviewMode: ReviewMode;
  agentTarballMaxMb: number;
  contextDocs: string[];
  // Pi engine (agent mode only)
  piVersion: string;
  piTimeoutMs: number;
  piLog: PiLogLevel;
  piThinking: PiThinkingLevel;
}

export interface RepoRoot {
  /** Extracted repo root directory. */
  path: string;
  /** Temp working directory to remove on cleanup. */
  workDir: string;
}

export type ConfigSource = 'workflow input' | 'repo variable' | 'default';

export type ConfigKnob =
  | 'apiType'
  | 'baseUrl'
  | 'model'
  | 'reviewMode'
  | 'autoReview'
  | 'extraInstructions'
  | 'contextDocs'
  | 'excludePatterns';

export type ConfigSources = Partial<Record<ConfigKnob, ConfigSource>>;

/** Workflow inputs as written; the variable-resolvable knobs are raw and unvalidated. */
export interface RawActionInputs {
  apiType?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  githubToken: string;
  appTokenUrl?: string;
  triggerComment: string;
  triggerLabel: string;
  autoReview?: string;
  maxFiles: number;
  maxDiffLines: number;
  useDefaultExcludes: boolean;
  reviewMode?: string;
  agentTarballMaxMb: number;
  piVersion: string;
  piTimeoutMs: number;
  piLog?: string;
  piThinking?: string;
}

export interface ResolvedConfig {
  inputs: ActionInputs;
  sources: ConfigSources;
}
