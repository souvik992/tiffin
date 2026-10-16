import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Runs a constant Windows PowerShell 5.1 script (ships with every Windows 10/11 install).
 * Safety rules for every caller: the script text is a constant; anything that comes from the database or a user
 * goes in an environment variable or on stdin, never into the command line. Output is capped; a timeout kills it.
 */
export interface PsResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export interface PsRequest { script: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number; maxOutput?: number }
export type PsRunner = (r: PsRequest) => Promise<PsResult>;

/** Full path, so a powershell.exe planted in the working directory or on PATH is never picked up. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export const runPowerShell: PsRunner = (r) => new Promise((resolve) => {
  const encoded = Buffer.from(r.script, 'utf16le').toString('base64');
  const max = r.maxOutput ?? 4096;
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, ...(r.env ?? {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let settled = false;
  const finish = (res: PsResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(res); };
  const timer = setTimeout(() => { child.kill(); finish({ code: null, stdout, stderr, timedOut: true }); }, r.timeoutMs ?? 30_000);
  child.stdout.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < max) stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4096) stderr += d; });
  child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message) }));
  child.on('close', (code) => finish({ code, stdout, stderr }));
  child.stdin.on('error', () => { /* reported through close */ });
  child.stdin.end(r.stdin ?? '');
});
