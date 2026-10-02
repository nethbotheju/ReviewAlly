/** Shapes emitted by pi in `--mode json` (JSONL on stdout). */

export interface PiContentPart {
  type: string;
  text?: string;
}

export interface PiUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface PiMessage {
  role: string;
  customType?: string;
  content?: PiContentPart[] | string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiEvent {
  type: string;
  message?: PiMessage;
  messages?: PiMessage[];
  // Tool-execution events (tool_execution_start / tool_execution_end)
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // Retry / compaction events
  attempt?: number;
  reason?: string;
  errorMessage?: string;
}
