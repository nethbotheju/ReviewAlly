import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { installDir, runNpm } from './pi-process';
import { PI_PACKAGE } from './pi-args';

export const PI_SDK_VERSION = '0.87.1';

export function sdkEntryPath(version: string = PI_SDK_VERSION): string {
  return path.join(installDir(version), 'node_modules', PI_PACKAGE, 'dist', 'index.js');
}

export async function ensurePiSdkInstalled(): Promise<string> {
  const entry = sdkEntryPath();
  if (fs.existsSync(entry)) return entry;

  const dir = installDir(PI_SDK_VERSION);
  fs.mkdirSync(dir, { recursive: true });
  core.info(`Installing pi SDK ${PI_SDK_VERSION} into ${dir}...`);
  await runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${PI_PACKAGE}@${PI_SDK_VERSION}`],
    dir,
  );
  if (!fs.existsSync(entry)) {
    throw new Error(`pi SDK ${PI_SDK_VERSION} was not installed at ${entry}.`);
  }
  return entry;
}
