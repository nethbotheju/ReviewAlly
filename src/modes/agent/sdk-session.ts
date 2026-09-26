import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ActionInputs, RepoRoot } from '../../config/types';
import { buildModelsJson, providerFor } from './pi-args';
import { createSandboxTools } from './sandbox-tools';
import { ensurePiSdkInstalled } from './sdk-install';

export const REVIEW_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

type ModelInputs = Pick<ActionInputs, 'apiType' | 'apiKey' | 'baseUrl' | 'model'>;

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type TypeBox = typeof import('typebox').Type;

async function loadEsmModule<T>(entry: string): Promise<T> {
  // Preserve native import(): TypeScript's CommonJS output otherwise rewrites it to require().
  const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<T>;
  return importModule(pathToFileURL(entry).href);
}

export function createReviewResourceLoader(
  systemPrompt: string,
  createExtensionRuntime: PiSdk['createExtensionRuntime'],
): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createReviewAgentSession(
  repoRoot: RepoRoot,
  systemPrompt: string,
  inputs: ModelInputs,
  options: {
    sdk?: PiSdk;
    sdkEntry?: string;
    typeBox?: TypeBox;
    createTools?: (type: TypeBox, sdk: PiSdk) => ToolDefinition[];
  } = {},
) {
  const sdkEntry = options.sdkEntry ?? (options.sdk ? undefined : await ensurePiSdkInstalled());
  const sdk = options.sdk ?? (await loadEsmModule<PiSdk>(sdkEntry!));
  const typeBox = options.createTools
    ? (options.typeBox ??
      (await loadEsmModule<{ Type: TypeBox }>(createRequire(sdkEntry!).resolve('typebox'))).Type)
    : undefined;
  const customTools = [
    ...createSandboxTools(sdk, repoRoot),
    ...(options.createTools?.(typeBox!, sdk) ?? []),
  ];
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-sdk-'));
  try {
    const {
      createAgentSession,
      createExtensionRuntime,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = sdk;
    const modelsPath =
      inputs.apiType === 'openai-chat-compatible' ? path.join(agentDir, 'models.json') : null;
    if (modelsPath) {
      fs.writeFileSync(modelsPath, JSON.stringify(buildModelsJson(inputs)), {
        mode: 0o600,
      });
    }

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = providerFor(inputs);
    await modelRuntime.setRuntimeApiKey(provider, inputs.apiKey);
    const model = modelRuntime.getModel(provider, inputs.model);
    if (!model) {
      throw new Error(`Model '${inputs.model}' is not available for pi provider '${provider}'.`);
    }

    const { session } = await createAgentSession({
      cwd: repoRoot.path,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: 'off',
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      sessionManager: SessionManager.inMemory(repoRoot.path),
      resourceLoader: createReviewResourceLoader(systemPrompt, createExtensionRuntime),
      tools: [...new Set([...REVIEW_TOOLS, ...customTools.map((tool) => tool.name)])],
      customTools,
    });

    return {
      session,
      dispose: () => {
        try {
          session.dispose();
        } finally {
          fs.rmSync(agentDir, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    fs.rmSync(agentDir, { recursive: true, force: true });
    throw err;
  }
}
