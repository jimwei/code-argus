/**
 * Shell-free git command execution
 *
 * Branch names and paths may contain shell metacharacters (`&`, `$`, `;`,
 * `(`, `)`, spaces, quotes) or non-ASCII characters. Building a command string
 * for `execSync` makes the shell interpret those characters, which truncates
 * the command: a valid branch such as
 * `feature/.../LB-14591-【Win&Web-給与-...】` is cut at `&` and reported as
 * `Branch not found`. Passing every argument as an argv array avoids the shell
 * entirely.
 */

import { execFileSync } from 'node:child_process';

export interface GitExecOptions {
  /** Working directory used for the git command */
  cwd: string;
  /** Max stdout/stderr buffer in bytes (defaults to Node's 1MB) */
  maxBuffer?: number;
}

/**
 * Run `git <args>` without a shell and return stdout as UTF-8.
 *
 * Throws on non-zero exit with `stderr`/`message` attached, matching the
 * error shape callers get from `execSync`.
 */
export function gitExec(args: string[], options: GitExecOptions): string {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });
}
