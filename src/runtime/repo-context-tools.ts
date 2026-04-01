import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { minimatch } from 'minimatch';
import { z } from 'zod';

import type { RuntimeToolDefinition } from './types.js';

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
const DEFAULT_GREP_RESULTS = 50;
const MAX_GREP_RESULTS = 100;
const DEFAULT_GLOB_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.worktrees']);

interface ReadToolArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

interface GrepToolArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  max_results?: number;
}

interface GlobToolArgs {
  pattern: string;
  path?: string;
  max_results?: number;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(candidate), 1), max);
}

function resolveRepoPath(repoPath: string, requestedPath: string): string {
  const root = resolve(repoPath);
  const target = resolve(root, requestedPath);
  const relativePath = relative(root, target);
  const normalizedRelative = normalizePath(relativePath);

  if (
    normalizedRelative === '..' ||
    normalizedRelative.startsWith('../') ||
    normalizedRelative.includes('/../')
  ) {
    throw new Error(`Path is outside the repository: ${requestedPath}`);
  }

  return target;
}

function toRepoRelativePath(repoPath: string, absolutePath: string): string {
  const relativePath = relative(resolve(repoPath), absolutePath);
  return normalizePath(relativePath || '.');
}

async function collectFiles(repoPath: string, startPath: string): Promise<string[]> {
  const root = resolve(repoPath);
  const startAbsolutePath = resolveRepoPath(root, startPath);
  const collected: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absoluteEntryPath = resolve(currentPath, entry.name);
      const relativeEntryPath = toRepoRelativePath(root, absoluteEntryPath);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(absoluteEntryPath);
        continue;
      }

      if (entry.isFile()) {
        collected.push(relativeEntryPath);
      }
    }
  }

  await walk(startAbsolutePath);
  collected.sort((left, right) => left.localeCompare(right));
  return collected;
}

function buildSearchRegex(pattern: string, ignoreCase: boolean): RegExp | undefined {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : undefined);
  } catch {
    return undefined;
  }
}

function matchesText(
  line: string,
  pattern: string,
  regex: RegExp | undefined,
  ignoreCase: boolean
): boolean {
  if (regex) {
    return regex.test(line);
  }

  if (ignoreCase) {
    return line.toLowerCase().includes(pattern.toLowerCase());
  }

  return line.includes(pattern);
}

export function createRepoContextTools(repoPath: string): RuntimeToolDefinition[] {
  let cachedRepoFiles: Promise<string[]> | null = null;

  const listRepoFiles = (startPath: string = '.'): Promise<string[]> => {
    if (startPath === '.') {
      cachedRepoFiles ??= collectFiles(repoPath, '.');
      return cachedRepoFiles;
    }

    return collectFiles(repoPath, startPath);
  };

  return [
    {
      name: 'Read',
      description:
        'Read file contents from the repository. Use offset and limit to inspect a specific line range when needed.',
      inputSchema: {
        file_path: z.string().describe('Repository-relative file path to read'),
        offset: z.number().int().positive().optional().describe('Starting line number (1-based)'),
        limit: z.number().int().positive().optional().describe('Maximum number of lines to return'),
      },
      execute: async (args: ReadToolArgs) => {
        const absolutePath = resolveRepoPath(repoPath, args.file_path);
        const relativePath = toRepoRelativePath(repoPath, absolutePath);
        const fileContent = await readFile(absolutePath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        const startLine = clamp(args.offset, 1, Math.max(lines.length, 1));
        const lineLimit = clamp(args.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
        const endLine = Math.min(lines.length, startLine + lineLimit - 1);
        const snippet = lines
          .slice(startLine - 1, endLine)
          .map((line, index) => `${startLine + index}\t${line}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `File: ${relativePath}\nLines: ${startLine}-${endLine}\n\n` + snippet,
            },
          ],
        };
      },
    },
    {
      name: 'Grep',
      description:
        'Search repository files for matching text or regex patterns and return matching lines with file and line numbers.',
      inputSchema: {
        pattern: z.string().describe('Text or regular expression pattern to search for'),
        path: z
          .string()
          .optional()
          .describe('Optional repository-relative subdirectory to search in'),
        glob: z.string().optional().describe('Optional glob pattern to filter candidate files'),
        ignore_case: z.boolean().optional().describe('Whether to search case-insensitively'),
        max_results: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of matches to return'),
      },
      execute: async (args: GrepToolArgs) => {
        const startPath = args.path || '.';
        const files = await listRepoFiles(startPath);
        const globPattern = args.glob || '**/*';
        const maxResults = clamp(args.max_results, DEFAULT_GREP_RESULTS, MAX_GREP_RESULTS);
        const regex = buildSearchRegex(args.pattern, args.ignore_case ?? false);
        const matches: string[] = [];

        for (const file of files) {
          const candidatePath =
            startPath === '.'
              ? file
              : normalizePath(
                  relative(resolveRepoPath(repoPath, startPath), resolveRepoPath(repoPath, file))
                );

          if (!minimatch(candidatePath, globPattern, { dot: true, matchBase: true })) {
            continue;
          }

          const fileContent = await readFile(resolveRepoPath(repoPath, file), 'utf8');
          const lines = fileContent.split(/\r?\n/);

          for (let index = 0; index < lines.length; index++) {
            if (!matchesText(lines[index]!, args.pattern, regex, args.ignore_case ?? false)) {
              continue;
            }

            matches.push(`${file}:${index + 1}\t${lines[index]}`);
            if (matches.length >= maxResults) {
              return {
                content: [
                  {
                    type: 'text',
                    text: matches.join('\n'),
                  },
                ],
              };
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: matches.length > 0 ? matches.join('\n') : 'No matches found.',
            },
          ],
        };
      },
    },
    {
      name: 'Glob',
      description:
        'Find repository files matching a glob pattern and return repository-relative paths.',
      inputSchema: {
        pattern: z.string().describe('Glob pattern to match, for example **/*.ts'),
        path: z
          .string()
          .optional()
          .describe('Optional repository-relative subdirectory to search in'),
        max_results: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of file paths to return'),
      },
      execute: async (args: GlobToolArgs) => {
        const startPath = args.path || '.';
        const files = await listRepoFiles(startPath);
        const maxResults = clamp(args.max_results, DEFAULT_GLOB_RESULTS, MAX_GLOB_RESULTS);
        const matches = files.filter((file) => {
          const candidatePath =
            startPath === '.'
              ? file
              : normalizePath(
                  relative(resolveRepoPath(repoPath, startPath), resolveRepoPath(repoPath, file))
                );

          return minimatch(candidatePath, args.pattern, { dot: true, matchBase: true });
        });

        return {
          content: [
            {
              type: 'text',
              text:
                matches.length > 0
                  ? matches.slice(0, maxResults).join('\n')
                  : 'No files matched the requested pattern.',
            },
          ],
        };
      },
    },
  ];
}
