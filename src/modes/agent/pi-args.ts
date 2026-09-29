import type { ActionInputs } from '../../config/types';

/** npm package name, used to install pi on the runner at runtime. */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Provider id registered in models.json for openai-chat-compatible endpoints. */
export const PI_CUSTOM_PROVIDER = 'custom';

/** Env var referenced by models.json ($ interpolation) for the compatible key. */
export const PI_CUSTOM_API_KEY_ENV = 'CUSTOM_API_KEY';

/** Env var pointing the ReviewAlly tools extension at the PR patch data. */
export const PI_DIFFS_FILE_ENV = 'REVIEWALLY_DIFFS_FILE';

/** Headless, ephemeral, read-only flags. Reused across runs and asserted by tests. */
const PI_FLAGS = [
  '-p', // print mode: process the prompt and exit
  '--no-session', // ephemeral; never persist
  '--mode',
  'json', // JSONL event stream on stdout
  '--offline', // no startup network (update checks / telemetry) — does not block the model call
  '--thinking',
  'off', // cost control
  '--no-extensions', // discovered extensions stay off; the ReviewAlly extension loads explicitly
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-themes',
  '--tools',
  // read-only investigation tools (no bash/edit/write) + ReviewAlly review tools
  'read,grep,find,ls,get_diff,submit_finding,finish_review',
] as const;

/** Map the action's api-type to a pi provider id. */
export function providerFor(inputs: ActionInputs): string {
  switch (inputs.apiType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'openai-chat-compatible':
      return PI_CUSTOM_PROVIDER;
    default: {
      const _exhaustive: never = inputs.apiType;
      throw new Error(`Unsupported api-type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Build the models.json content for an openai-chat-compatible endpoint. The key is
 * referenced via env interpolation ($CUSTOM_API_KEY) so it never
 * appears in argv or on disk in plaintext beyond the process env.
 */
export function buildModelsJson(inputs: ActionInputs): Record<string, unknown> {
  if (inputs.apiType !== 'openai-chat-compatible') {
    throw new Error('buildModelsJson is only for openai-chat-compatible.');
  }
  return {
    providers: {
      [PI_CUSTOM_PROVIDER]: {
        name: 'AI Review Compatible',
        baseUrl: inputs.baseUrl,
        api: 'openai-completions',
        apiKey: `$${PI_CUSTOM_API_KEY_ENV}`,
        // Maximise compatibility with arbitrary OpenAI-compatible servers:
        // send the system prompt as a `system` message and skip reasoning knobs.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: inputs.model }],
      },
    },
  };
}

/**
 * Build the pi CLI args for a headless read-only review run. The ReviewAlly
 * tools extension is passed explicitly (explicit --extension paths load even
 * with --no-extensions). Assumes models.json (for compatible) has already
 * been written to the config dir.
 */
export function buildPiArgs(
  systemPrompt: string,
  userPrompt: string,
  inputs: ActionInputs,
  extensionPath: string,
): string[] {
  return [
    ...PI_FLAGS,
    '--extension',
    extensionPath,
    '--system-prompt',
    systemPrompt,
    '--provider',
    providerFor(inputs),
    '--model',
    inputs.model,
    userPrompt,
  ];
}

/** Build the child-process env. The API key is injected via env, never argv. */
export function buildPiEnv(
  inputs: ActionInputs,
  configDir: string,
  diffsFile?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: configDir,
  };
  if (diffsFile) {
    env[PI_DIFFS_FILE_ENV] = diffsFile;
  }
  if (inputs.apiType === 'anthropic') {
    env.ANTHROPIC_API_KEY = inputs.apiKey;
  } else if (inputs.apiType === 'openai') {
    env.OPENAI_API_KEY = inputs.apiKey;
  } else {
    env[PI_CUSTOM_API_KEY_ENV] = inputs.apiKey;
  }
  return env;
}
