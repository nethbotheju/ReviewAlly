/** Type surface of the plain-JS pi extension (see reviewally-tools.js). */
export interface ExtensionTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

export default function registerReviewallyTools(pi: {
  registerTool: (tool: ExtensionTool) => void;
}): void;
