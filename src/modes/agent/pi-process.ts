import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import * as core from '@actions/core';
import { PI_PACKAGE } from './pi-args';
import type { PiEvent } from './pi-types';

const SIGKILL_DELAY_MS = 5000;

function isPiEvent(value: unknown): value is PiEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Directory where pi is installed on the runner. */
export function installDir(version: string): string {
  return path.join(os.homedir(), '.cache', 'reviewally-pi', version);
}

/** Absolute path to the bundled CLI entry inside the install dir. */
export function cliEntryPath(version: string): string {
  return path.join(installDir(version), 'node_modules', PI_PACKAGE, 'dist', 'cli.js');
}

/**
 * Ensure pi is installed for the given version. Idempotent: skips if the CLI
 * entry already exists. Returns the absolute path to the bundled CLI entry point.
 */
export async function ensurePiInstalled(version: string): Promise<string> {
  const entry = cliEntryPath(version);
  if (fs.existsSync(entry)) {
    core.info(`pi ${version} found at ${installDir(version)} (already installed).`);
    return entry;
  }

  const dir = installDir(version);
  fs.mkdirSync(dir, { recursive: true });
  core.info(`Installing ${PI_PACKAGE}@${version} into ${dir} ...`);

  await runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${PI_PACKAGE}@${version}`],
    dir,
  );

  if (!fs.existsSync(entry)) {
    throw new Error(`npm reported success but the pi CLI entry was not found at ${entry}.`);
  }
  core.info('pi installed.');
  return entry;
}

/** Run an npm command in `cwd`. Streams stdout live; captures stderr to include in the failure message. */
export function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('npm', args, { cwd, stdio: ['inherit', 'inherit', 'pipe'] });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.length > 4000 ? `…${stderr.slice(-4000)}` : stderr;
        reject(new Error(`npm ${args.join(' ')} exited with code ${code}.\nstderr:\n${tail}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Spawn the pi CLI, stream its JSONL stdout into parsed events, and resolve on
 * completion. Enforces a hard timeout (SIGTERM then SIGKILL). `onEvent`, when
 * given, receives every parsed event in order (live trace). On timeout the
 * promise RESOLVES with the partial events and `timedOut: true` so the caller
 * can still use and log what happened before the kill. Rejects only if the
 * process produces no events and exits non-zero, or fails to spawn.
 */
export function invokePi(
  cliEntry: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onEvent?: (event: PiEvent) => void,
): Promise<{ events: PiEvent[]; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const events: PiEvent[] = [];
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, SIGKILL_DELAY_MS);
    }, timeoutMs);

    // JSONL records are LF-terminated. Node's readline also treats U+2028/U+2029
    // as line separators, which can corrupt records whose JSON strings contain
    // those characters (e.g. model-authored tool arguments), so split on LF only.
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPiEvent(parsed)) {
          events.push(parsed);
          onEvent?.(parsed);
        }
      } catch {
        /* skip non-JSON lines */
      }
    };

    let buffer = '';
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        idx = buffer.indexOf('\n');
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (buffer.trim()) handleLine(buffer);
      if (timedOut) {
        resolve({ events, stderr, timedOut: true });
        return;
      }
      if (code !== 0) {
        if (events.length === 0) {
          reject(
            new Error(
              `pi exited with code ${code} and produced no output.\nstderr:\n${stderr.slice(0, 2000)}`,
            ),
          );
        } else {
          core.warning(
            `pi exited with code ${code} but produced ${events.length} event(s); using partial output.`,
          );
        }
      }
      resolve({ events, stderr, timedOut: false });
    });
  });
}
