/**
 * .argusignore file support
 *
 * Loads and applies gitignore-style patterns from .argusignore files
 * in config directories to filter out files from code review.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';

/**
 * Load .argusignore patterns from config directories
 *
 * @param configDirs - Array of config directory paths
 * @returns Array of ignore patterns (merged from all config dirs)
 */
export function loadReviewIgnorePatterns(configDirs: string[]): string[] {
  const patterns: string[] = [];

  for (const dir of configDirs) {
    const filePath = join(dir, '.argusignore');
    if (!existsSync(filePath)) {
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      for (const raw of lines) {
        const line = raw.trim();
        // Skip empty lines and comments
        if (!line || line.startsWith('#')) {
          continue;
        }
        patterns.push(line);
      }
    } catch {
      // Silently skip unreadable files
    }
  }

  return patterns;
}

/**
 * Check if a file path matches any of the ignore patterns
 *
 * Supports gitignore-style patterns:
 * - `*.test.ts` — file extension matching
 * - `**\/__tests__/**` — directory matching
 * - `docs/**` — directory prefix
 * - `!important.test.ts` — negation (un-ignore)
 *
 * @param filePath - File path from diff (e.g. "src/utils/helper.test.ts")
 * @param patterns - Array of ignore patterns
 * @returns true if the file should be ignored
 */
export function isFileIgnored(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  // Process patterns in order, supporting negation
  let ignored = false;

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      // Negation pattern — un-ignore
      const negated = pattern.slice(1);
      if (matchPattern(filePath, negated)) {
        ignored = false;
      }
    } else {
      // Normal pattern — ignore
      if (matchPattern(filePath, pattern)) {
        ignored = true;
      }
    }
  }

  return ignored;
}

/**
 * Match a file path against a single pattern
 *
 * Handles gitignore-style semantics:
 * - Patterns without `/` match against the basename
 * - Patterns with `/` match against the full path
 * - Trailing `/` matches directories (treated as prefix match)
 */
function matchPattern(filePath: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Trailing slash means directory match — treat as prefix
  if (pattern.endsWith('/')) {
    const dirPattern = pattern.slice(0, -1);
    return (
      normalizedPath.startsWith(dirPattern + '/') || normalizedPath.includes('/' + dirPattern + '/')
    );
  }

  // If pattern contains `/`, match against full path
  if (pattern.includes('/')) {
    return minimatch(normalizedPath, pattern, { dot: true, matchBase: false });
  }

  // No `/` in pattern — match against basename (like gitignore)
  return minimatch(normalizedPath, pattern, { dot: true, matchBase: true });
}

/**
 * Remove ignored files' diff blocks from raw diff text
 *
 * This ensures ignored files don't consume LLM tokens in agent prompts.
 *
 * @param rawDiff - Raw git diff output
 * @param ignoredPaths - File paths that were filtered out by .argusignore
 * @returns Cleaned diff text with ignored file blocks removed
 */
export function stripIgnoredFromDiff(rawDiff: string, ignoredPaths: string[]): string {
  if (ignoredPaths.length === 0) {
    return rawDiff;
  }

  let result = rawDiff;
  for (const filePath of ignoredPaths) {
    const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match from "diff --git a/... b/path" to next "diff --git" or end of string
    // Only anchor on b-path to handle renames (a-path may differ)
    const regex = new RegExp(
      `diff --git a\\/[^\\s]+ b\\/${escapedPath}\\n[\\s\\S]*?(?=diff --git |$)`,
      'g'
    );
    result = result.replace(regex, '');
  }

  return result;
}
