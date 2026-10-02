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
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
}

export default function registerReviewallyTools(pi: {
  registerTool: (tool: ExtensionTool) => void;
  on: (event: string, handler: () => void) => void;
  setActiveTools: (tools: string[]) => void;
  setThinkingLevel: (level: string) => void;
  sendMessage: (
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: string; triggerTurn: boolean },
  ) => void;
}): void;
