import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { Minimatch } from 'minimatch';
import { z } from 'zod';

import type { RuntimeToolDefinition } from './types.js';

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
const DEFAULT_GREP_RESULTS = 50;
const MAX_GREP_RESULTS = 100;
const DEFAULT_GLOB_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
// Tool output is replayed into the model on every turn, so a single unbounded
// read or grep match (for example a 1.9 MB single-line iconfont bundle) can push
// the whole review past the provider context window. These budgets keep the
// payload finite; large results are truncated with a continuation hint.
const DEFAULT_READ_BYTE_LIMIT = 64 * 1024;
const MAX_READ_BYTE_LIMIT = 256 * 1024;
const DEFAULT_GREP_BYTE_LIMIT = 48 * 1024;
const MAX_GREP_BYTE_LIMIT = 256 * 1024;
const DEFAULT_GREP_LINE_CHAR_LIMIT = 400;
const MAX_GREP_LINE_CHAR_LIMIT = 4000;
const DEFAULT_MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const MAX_MAX_INDEXED_FILE_BYTES = 8 * 1024 * 1024;
const STAT_CONCURRENCY = 32;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.worktrees']);
// Generated bundles, lockfiles, and binary assets are noise for repository-wide
// scanning and are frequently huge (or single-line), so they are skipped unless
// the caller overrides `excludedFilePatterns`.
const DEFAULT_EXCLUDED_FILE_PATTERNS = [
  '**/*.min.js',
  '**/*.min.mjs',
  '**/*.min.css',
  '**/*.bundle.js',
  '**/iconfont.js',
  '**/*.map',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/dist/**',
  '**/coverage/**',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.bmp',
  '**/*.ico',
  '**/*.pdf',
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
  '**/*.eot',
  '**/*.zip',
  '**/*.gz',
  '**/*.7z',
  '**/*.mp3',
  '**/*.mp4',
  '**/*.mov',
  '**/*.xls',
  '**/*.xlsx',
  '**/*.doc',
  '**/*.docx',
];

export interface FocusedReadWindow {
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  contextLines?: number;
}

export interface RepoContextToolsOptions {
  defaultReadLimit?: number;
  maxReadLimit?: number;
  focusedReadWindow?: FocusedReadWindow;
  /** Approximate byte budget for one Read result. */
  readByteLimit?: number;
  /** Approximate byte budget for one Grep result. */
  grepByteLimit?: number;
  /** Matched Grep lines longer than this are truncated. */
  grepLineCharLimit?: number;
  /** Files larger than this are hidden from Grep and Glob. */
  maxIndexedFileBytes?: number;
  /** Overrides the default generated/binary file exclusion globs. */
  excludedFilePatterns?: string[];
}

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

const MINIMATCH_OPTIONS = { dot: true, matchBase: true } as const;

function buildCombinedGlobPattern(patterns: readonly string[]): string | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  if (patterns.length === 1) {
    return patterns[0];
  }

  // Brace-expanding the exclusion list keeps filtering to a single minimatch
  // call per file instead of one call per pattern.
  if (patterns.some((pattern) => /[{}[\]]/u.test(pattern))) {
    return undefined;
  }

  return `{${patterns.join(',')}}`;
}

function createGlobMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const combinedPattern = buildCombinedGlobPattern(patterns);

  if (combinedPattern !== undefined) {
    // Compile once: calling minimatch() would re-parse the pattern for every file.
    const combined = new Minimatch(combinedPattern, MINIMATCH_OPTIONS);
    return (relativePath: string) => combined.match(relativePath);
  }

  const compiled = patterns.map((pattern) => new Minimatch(pattern, MINIMATCH_OPTIONS));
  return (relativePath: string) => compiled.some((matcher) => matcher.match(relativePath));
}

function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateToByteLength(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }

  const decoded = buffer.subarray(0, maxBytes).toString('utf8');
  // The cut can land inside a multi-byte code point; drop the partial tail so
  // CJK lines do not end with a replacement character.
  return decoded.endsWith('\uFFFD') ? decoded.slice(0, -1) : decoded;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }

  return `${Math.round(bytes / 1024)} KB`;
}

function truncateToCharLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const sliced = text.slice(0, maxChars);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  // A cut between surrogate halves would emit a lone surrogate, so drop it.
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    return sliced.slice(0, -1);
  }

  return sliced;
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

interface RepoFileFilters {
  isExcluded: (relativePath: string) => boolean;
  maxFileBytes: number;
}

interface CollectedFiles {
  files: string[];
  skippedCount: number;
}

async function keepFilesWithinSizeLimit(
  repoPath: string,
  candidates: readonly string[],
  maxFileBytes: number
): Promise<{ kept: string[]; skipped: number }> {
  const kept: boolean[] = new Array<boolean>(candidates.length).fill(false);
  let cursor = 0;
  const workerCount = Math.min(STAT_CONCURRENCY, candidates.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];

      if (candidate === undefined) {
        continue;
      }

      try {
        const fileStat = await stat(resolve(repoPath, candidate));
        kept[index] = fileStat.size <= maxFileBytes;
      } catch {
        kept[index] = false;
      }
    }
  });

  await Promise.all(workers);

  const keptFiles: string[] = [];
  let skipped = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (kept[index]) {
      keptFiles.push(candidates[index]!);
    } else {
      skipped += 1;
    }
  }

  return { kept: keptFiles, skipped };
}

async function collectFiles(
  repoPath: string,
  startPath: string,
  filters: RepoFileFilters
): Promise<CollectedFiles> {
  const root = resolve(repoPath);
  const startAbsolutePath = resolveRepoPath(root, startPath);
  const matched: string[] = [];
  let excludedCount = 0;
  const isExcluded = filters.isExcluded;

  const startStat = await lstat(startAbsolutePath);
  // The repository root itself may be reached through a symlink or junction, so walk it as
  // given. Symlinked paths below the root stay refused, matching the walker's policy of
  // never following symlinked entries.
  if (startStat.isSymbolicLink() && startAbsolutePath !== root) {
    return { files: [], skippedCount: 0 };
  }
  if (startStat.isFile()) {
    // An explicit file path bypasses the listing filters; the caller asked for it and the
    // output caps still bound the result.
    return { files: [toRepoRelativePath(root, startAbsolutePath)], skippedCount: 0 };
  }

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
        if (isExcluded(relativeEntryPath)) {
          excludedCount += 1;
          continue;
        }

        matched.push(relativeEntryPath);
      }
    }
  }

  await walk(startAbsolutePath);
  matched.sort((left, right) => left.localeCompare(right));

  const { kept, skipped } = await keepFilesWithinSizeLimit(root, matched, filters.maxFileBytes);

  return {
    files: kept,
    skippedCount: excludedCount + skipped,
  };
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

function getReadBounds(
  relativePath: string,
  lineCount: number,
  args: ReadToolArgs,
  options: RepoContextToolsOptions
): { startLine: number; lineLimit: number } {
  const maxReadLimit = clamp(options.maxReadLimit, MAX_READ_LIMIT, MAX_READ_LIMIT);
  const defaultReadLimit = clamp(options.defaultReadLimit, DEFAULT_READ_LIMIT, maxReadLimit);
  const focusedWindow = options.focusedReadWindow;
  const normalizedReadPath = normalizePath(relativePath);
  const focusedFilePath = focusedWindow ? normalizePath(focusedWindow.filePath) : undefined;
  const focusApplies =
    Boolean(focusedWindow && focusedFilePath === normalizedReadPath) && args.offset === undefined;

  if (!focusApplies || !focusedWindow) {
    return {
      startLine: clamp(args.offset, 1, Math.max(lineCount, 1)),
      lineLimit: clamp(args.limit, defaultReadLimit, maxReadLimit),
    };
  }

  const contextLines = clamp(focusedWindow.contextLines, 40, maxReadLimit);
  const lineStart = clamp(focusedWindow.lineStart, 1, Math.max(lineCount, 1));
  const lineEnd = clamp(focusedWindow.lineEnd, lineStart, Math.max(lineCount, 1));
  const issueLineCount = Math.max(lineEnd - lineStart + 1, 1);
  const focusedDefaultLimit = Math.min(maxReadLimit, issueLineCount + contextLines * 2);

  return {
    startLine: Math.max(1, lineStart - contextLines),
    lineLimit: clamp(args.limit, focusedDefaultLimit, maxReadLimit),
  };
}

export function createRepoContextTools(
  repoPath: string,
  options: RepoContextToolsOptions = {}
): RuntimeToolDefinition[] {
  const excludedFilePatterns = options.excludedFilePatterns ?? DEFAULT_EXCLUDED_FILE_PATTERNS;
  const readByteLimit = clamp(options.readByteLimit, DEFAULT_READ_BYTE_LIMIT, MAX_READ_BYTE_LIMIT);
  const grepByteLimit = clamp(options.grepByteLimit, DEFAULT_GREP_BYTE_LIMIT, MAX_GREP_BYTE_LIMIT);
  const grepLineCharLimit = clamp(
    options.grepLineCharLimit,
    DEFAULT_GREP_LINE_CHAR_LIMIT,
    MAX_GREP_LINE_CHAR_LIMIT
  );
  const isExcludedFile = createGlobMatcher(excludedFilePatterns);
  const fileFilters: RepoFileFilters = {
    isExcluded: isExcludedFile,
    maxFileBytes: clamp(
      options.maxIndexedFileBytes,
      DEFAULT_MAX_INDEXED_FILE_BYTES,
      MAX_MAX_INDEXED_FILE_BYTES
    ),
  };
  const fileListCache = new Map<string, Promise<CollectedFiles>>();

  const listRepoFiles = (startPath: string = '.'): Promise<CollectedFiles> => {
    const cached = fileListCache.get(startPath);
    if (cached) {
      return cached;
    }

    const pending = collectFiles(repoPath, startPath, fileFilters);
    fileListCache.set(startPath, pending);
    return pending;
  };

  return [
    {
      name: 'Read',
      description: options.focusedReadWindow
        ? `Read file contents from the repository. Omit offset when reading ${normalizePath(
            options.focusedReadWindow.filePath
          )} to inspect a focused window around lines ${options.focusedReadWindow.lineStart}-${
            options.focusedReadWindow.lineEnd ?? options.focusedReadWindow.lineStart
          }; use offset and limit for other specific ranges. Output is capped at roughly ${Math.round(
            readByteLimit / 1024
          )} KB per call; oversized files are truncated with a continuation hint.`
        : `Read file contents from the repository. Use offset and limit to inspect a specific line range when needed. Output is capped at roughly ${Math.round(
            readByteLimit / 1024
          )} KB per call; oversized files are truncated with a continuation hint.`,
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
        const { startLine, lineLimit } = getReadBounds(relativePath, lines.length, args, options);
        const requestedEndLine = Math.min(lines.length, startLine + lineLimit - 1);
        const snippetLines: string[] = [];
        let usedBytes = 0;
        let endLine = startLine - 1;
        let clippedLine = false;

        for (let lineNumber = startLine; lineNumber <= requestedEndLine; lineNumber++) {
          const renderedLine = `${lineNumber}\t${lines[lineNumber - 1] ?? ''}`;
          const renderedBytes = byteLengthOf(renderedLine);
          const remainingBytes = readByteLimit - usedBytes;

          if (remainingBytes <= 0) {
            break;
          }

          if (renderedBytes > remainingBytes) {
            // A single oversized line (minified bundle) is clipped rather than
            // dropped, so the caller still sees how the line starts.
            if (snippetLines.length === 0) {
              const clipped = `${truncateToByteLength(renderedLine, remainingBytes)}…[line clipped]`;
              snippetLines.push(clipped);
              usedBytes += byteLengthOf(clipped);
              endLine = lineNumber;
              clippedLine = true;
            }
            break;
          }

          snippetLines.push(renderedLine);
          usedBytes += renderedBytes + 1;
          endLine = lineNumber;
        }

        const notes: string[] = [];
        if (isExcludedFile(relativePath)) {
          notes.push(
            `Note: ${relativePath} is excluded from repository-wide scanning (generated or binary file); content may be low signal.`
          );
        }
        if (clippedLine) {
          const continuation =
            endLine < lines.length
              ? ` — call Read again with offset=${endLine + 1} to continue after it`
              : '';
          notes.push(
            `[output truncated at ${readByteLimit} bytes; line ${endLine} exceeds the byte budget${continuation}]`
          );
        } else if (endLine < requestedEndLine) {
          notes.push(
            `[output truncated at ${readByteLimit} bytes; next line is ${
              endLine + 1
            } — call Read again with offset=${endLine + 1}]`
          );
        }

        const header = [`File: ${relativePath}`, `Lines: ${startLine}-${endLine}`, ...notes].join(
          '\n'
        );

        return {
          content: [
            {
              type: 'text',
              text: `${header}\n\n${snippetLines.join('\n')}`,
            },
          ],
        };
      },
    },
    {
      name: 'Grep',
      description: `Search repository files for matching text or regex patterns and return matching lines with file and line numbers. Generated bundles, lockfiles, binary assets, and files larger than ${formatByteSize(
        fileFilters.maxFileBytes
      )} are skipped; long match lines are truncated and the total output is capped at roughly ${Math.round(
        grepByteLimit / 1024
      )} KB.`,
      inputSchema: {
        pattern: z.string().describe('Text or regular expression pattern to search for'),
        path: z
          .string()
          .optional()
          .describe('Optional repository-relative file or directory to search in'),
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
        const { files, skippedCount } = await listRepoFiles(startPath);
        const globPattern = args.glob || '**/*';
        const globMatcher = new Minimatch(globPattern, MINIMATCH_OPTIONS);
        const maxResults = clamp(args.max_results, DEFAULT_GREP_RESULTS, MAX_GREP_RESULTS);
        const regex = buildSearchRegex(args.pattern, args.ignore_case ?? false);
        const matches: string[] = [];
        let usedBytes = 0;
        let truncatedByBytes = false;
        const skippedNote =
          skippedCount > 0
            ? `[${skippedCount} generated, binary, or oversized file(s) were skipped during scanning; use Read with an explicit path to inspect one]`
            : undefined;
        const appendNotes = (body: string, notes: Array<string | undefined>): string =>
          [body, ...notes.filter((note): note is string => Boolean(note))].join('\n');

        for (const file of files) {
          const candidatePath =
            startPath === '.' ||
            resolveRepoPath(repoPath, startPath) === resolveRepoPath(repoPath, file)
              ? file
              : normalizePath(
                  relative(resolveRepoPath(repoPath, startPath), resolveRepoPath(repoPath, file))
                );

          if (!globMatcher.match(candidatePath)) {
            continue;
          }

          const fileContent = await readFile(resolveRepoPath(repoPath, file), 'utf8');
          const lines = fileContent.split(/\r?\n/);

          for (let index = 0; index < lines.length; index++) {
            if (!matchesText(lines[index]!, args.pattern, regex, args.ignore_case ?? false)) {
              continue;
            }

            const matchedLine = lines[index] ?? '';
            const truncatedLine = truncateToCharLength(matchedLine, grepLineCharLimit);
            const renderedLine =
              truncatedLine.length < matchedLine.length
                ? `${truncatedLine}…[+${matchedLine.length - truncatedLine.length} chars]`
                : matchedLine;
            const matchLine = `${file}:${index + 1}\t${renderedLine}`;
            const matchBytes = byteLengthOf(matchLine) + 1;

            if (usedBytes + matchBytes > grepByteLimit) {
              truncatedByBytes = true;
              break;
            }

            matches.push(matchLine);
            usedBytes += matchBytes;
            if (matches.length >= maxResults) {
              return {
                content: [
                  {
                    type: 'text',
                    text: appendNotes(matches.join('\n'), [skippedNote]),
                  },
                ],
              };
            }
          }

          if (truncatedByBytes) {
            break;
          }
        }

        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: appendNotes('No matches found.', [
                  truncatedByBytes
                    ? `[grep output truncated at ${grepByteLimit} bytes; refine the pattern or path to see more matches]`
                    : undefined,
                  skippedNote,
                ]),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: appendNotes(matches.join('\n'), [
                truncatedByBytes
                  ? `[grep output truncated at ${grepByteLimit} bytes; refine the pattern or path to see more matches]`
                  : undefined,
                skippedNote,
              ]),
            },
          ],
        };
      },
    },
    {
      name: 'Glob',
      description:
        'Find repository files matching a glob pattern and return repository-relative paths. Generated bundles, lockfiles, binary assets, and oversized files are skipped by default.',
      inputSchema: {
        pattern: z.string().describe('Glob pattern to match, for example **/*.ts'),
        path: z
          .string()
          .optional()
          .describe('Optional repository-relative file or directory to search in'),
        max_results: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of file paths to return'),
      },
      execute: async (args: GlobToolArgs) => {
        const startPath = args.path || '.';
        const { files, skippedCount } = await listRepoFiles(startPath);
        const maxResults = clamp(args.max_results, DEFAULT_GLOB_RESULTS, MAX_GLOB_RESULTS);
        const patternMatcher = new Minimatch(args.pattern, MINIMATCH_OPTIONS);
        const matches = files.filter((file) => {
          const candidatePath =
            startPath === '.' ||
            resolveRepoPath(repoPath, startPath) === resolveRepoPath(repoPath, file)
              ? file
              : normalizePath(
                  relative(resolveRepoPath(repoPath, startPath), resolveRepoPath(repoPath, file))
                );

          return patternMatcher.match(candidatePath);
        });
        const skippedNote =
          skippedCount > 0
            ? `[${skippedCount} generated, binary, or oversized file(s) were skipped during scanning; use Read with an explicit path to inspect one]`
            : undefined;
        const body =
          matches.length > 0
            ? matches.slice(0, maxResults).join('\n')
            : 'No files matched the requested pattern.';

        return {
          content: [
            {
              type: 'text',
              text: skippedNote ? `${body}\n${skippedNote}` : body,
            },
          ],
        };
      },
    },
  ];
}
