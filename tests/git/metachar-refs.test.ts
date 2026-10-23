import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveRef } from '../../src/git/ref.js';
import { getDiffByRefs, getManagedWorktree } from '../../src/git/diff.js';

// Ref names may contain characters the shell treats specially (`&`, `$`, `;`, ...)
// as well as non-ASCII text. A real PR branch:
// feature/V202611/YY/LB-14591-【Win&Web-給与-源泉徴収票】「特親」...
// Building a shell command from such a ref truncates it at `&` and makes an
// existing branch look deleted.
const BRANCH =
  'feature/V202611/YY/LB-14591-【Win&Web-給与-源泉徴収票】「特親」人数未按「年調あり／なし」';

describe('git refs containing shell metacharacters', () => {
  let root: string;
  let remotePath: string;
  let repoPath: string;
  let expectedSha: string;

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'argus-metachar-ref-'));
    remotePath = join(root, 'remote.git');
    repoPath = join(root, 'repo');

    git(root, ['init', '--bare', '-b', 'main', remotePath]);
    git(root, ['init', '-b', 'main', repoPath]);
    git(repoPath, ['config', 'user.email', 'test@test.com']);
    git(repoPath, ['config', 'user.name', 'Test']);
    writeFileSync(join(repoPath, 'a.txt'), 'base\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-m', 'base']);
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', 'origin', 'main']);

    git(repoPath, ['checkout', '-b', BRANCH]);
    appendFileSync(join(repoPath, 'a.txt'), 'change\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-m', 'change']);
    git(repoPath, ['push', 'origin', `HEAD:refs/heads/${BRANCH}`]);
    expectedSha = git(repoPath, ['rev-parse', 'HEAD']).trim();
    git(repoPath, ['checkout', 'main']);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolveRef resolves a branch name with metacharacters', () => {
    expect(resolveRef(repoPath, BRANCH, 'origin').resolvedSha).toBe(expectedSha);
  });

  it('getDiffByRefs computes the diff for such a branch', () => {
    const result = getDiffByRefs({ repoPath, sourceRef: BRANCH, targetRef: 'main' });
    expect(result.diff).toContain('+change');
    expect(result.sourceBranch).toBe(BRANCH);
  });

  it('getManagedWorktree checks out such a branch', () => {
    const info = getManagedWorktree(repoPath, BRANCH, 'origin', {
      baseDir: join(root, 'worktrees'),
      autoCleanup: false,
    });
    expect(git(info.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(expectedSha);
  });
});
