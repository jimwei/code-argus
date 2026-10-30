import { describe, expect, it, vi } from 'vitest';
import { parseDiff } from '../../src/git/parser.js';
import { preprocessDiff } from '../../src/diff/preprocessor.js';
import { isBinaryContent, isBinaryDiff, isBinaryPath } from '../../src/utils/binary-files.js';

const workbook =
  'Developing/SourceCode/Kaikei90DB/Kaikei90DB/Kaikei90DB/Document/Leyser Product Service-Menu-Page Setting Kaikei.xls';

function textDiff(path: string, added = 'SELECT 2;'): string {
  return `diff --git a/${path} b/${path}\nindex abc123..def456 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-SELECT 1;\n+${added}\n`;
}

function binaryDiff(path: string, marker = `Binary files a/${path} and b/${path} differ`): string {
  return `diff --git a/${path} b/${path}\nindex abc123..def456 100644\n${marker}\n`;
}

describe('binary file detection', () => {
  it.each(['xls', 'XLS', 'Xlsx', 'XLSM', 'xlsb', 'docx', 'zip', 'png', 'woff2', 'mp4', 'dll'])(
    'recognizes .%s paths',
    (extension) => {
      expect(isBinaryPath(`資料/report with spaces.${extension}`)).toBe(true);
    }
  );

  it.each(['csv', 'sql', 'xml', 'json', 'svg', 'rtf', 'dat'])(
    'does not classify .%s as binary by extension',
    (extension) => {
      expect(isBinaryPath(`資料/report.${extension}`)).toBe(false);
    }
  );

  it('does not mistake inherited object names for binary extensions', () => {
    expect(isBinaryPath('file.constructor')).toBe(false);
    expect(isBinaryPath('file.toString')).toBe(false);
    expect(isBinaryPath('file.__proto__')).toBe(false);
  });

  it.each(['\0', '\x01', '\x08', '\x1b', '\x7f'])(
    'detects control byte %j in strings and bytes',
    (control) => {
      expect(isBinaryContent(`header${control}payload`)).toBe(true);
      expect(isBinaryContent(new Uint8Array([65, control.charCodeAt(0), 66]))).toBe(true);
    }
  );

  it('accepts non-ASCII SQL and normal text whitespace', () => {
    const sql = "SELECT '会計 😀 café';\t\r\n\f";
    expect(isBinaryContent(sql)).toBe(false);
    expect(isBinaryContent(Buffer.from(sql, 'utf8'))).toBe(false);
    expect(isBinaryContent(new Uint8Array([0x80, 0xff]))).toBe(false);
  });

  it('excludes binary bytes after a long text prefix from the review prompt', () => {
    const raw = textDiff('payload.unknown', `${'a'.repeat(8192)}\0private bytes`);
    expect(parseDiff(raw)).toEqual([]);
    expect(preprocessDiff(raw, {}).processedDiff).toBe('');
  });

  it.each(['Binary files a/blob.unknown and b/blob.unknown differ', 'GIT binary patch'])(
    'detects binary metadata %s',
    (marker) => {
      expect(isBinaryDiff(`${marker}\r\n`)).toBe(true);
      for (const prefix of ['+', '-', ' ']) {
        expect(isBinaryDiff(`${prefix}${marker}\n`)).toBe(false);
      }
    }
  );
});

describe('binary diff exclusion', () => {
  it('retains only SQL in the reported mixed SQL/workbook diff', () => {
    const sql = textDiff('Developing/会計 schema.sql', "SELECT '会計 😀';");
    const raw = binaryDiff(workbook) + sql;
    expect(parseDiff(raw).map((file) => file.path)).toEqual(['Developing/会計 schema.sql']);
    const result = preprocessDiff(raw);
    expect(result.diffFiles.map((file) => file.path)).toEqual(['Developing/会計 schema.sql']);
    expect(result.processedDiff).toBe(sql);
    expect(result.processedSize).toBe(Buffer.byteLength(sql, 'utf8'));
    expect(result.stats.savedBytes).toBe(Buffer.byteLength(binaryDiff(workbook), 'utf8'));
  });

  it.each([
    ['"a/src/\\344\\270\\255.ts" "b/src/\\344\\270\\255.ts"', 'src/中.ts'],
    ['"a/docs/日本語.md" "b/docs/日本語.md"', 'docs/日本語.md'],
    ['a/src/old.ts "b/src/\\344\\270\\255.ts"', 'src/中.ts'],
  ])('keeps quoted text paths in mixed review input', (header, path) => {
    const quoted = `diff --git ${header}\n@@ -1 +1 @@\n-old\n+new\n`;
    const raw = binaryDiff(workbook) + quoted + textDiff('ordinary.sql');
    const result = preprocessDiff(raw);
    expect(result.diffFiles.map((file) => file.path)).toEqual([path, 'ordinary.sql']);
    expect(result.processedDiff).toBe(quoted + textDiff('ordinary.sql'));
  });

  it('reviews Graphviz text rather than treating its ambiguous suffix as a binary format', () => {
    const raw = textDiff('docs/dependencies.dot', 'digraph { api -> database; }');
    expect(preprocessDiff(raw).diffFiles.map((file) => file.path)).toEqual([
      'docs/dependencies.dot',
    ]);
    expect(preprocessDiff(raw).processedDiff).toBe(raw);
  });

  it.each([
    binaryDiff(workbook),
    textDiff(workbook.toUpperCase()),
    binaryDiff('blob.unknown'),
    binaryDiff('blob.unknown', 'GIT binary patch\nliteral 10\nAbc123'),
    textDiff('blob.unknown', 'data\0payload'),
    textDiff('blob.unknown', 'data\x01payload'),
  ])('silently returns no review files for binary-only input', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(parseDiff(raw)).toEqual([]);
      const result = preprocessDiff(raw, { verbose: true });
      expect(result.diffFiles).toEqual([]);
      expect(result.deletedFiles).toEqual([]);
      expect(result.processedDiff).toBe('');
      expect(result.processedSize).toBe(0);
      expect(result.stats.originalFileCount).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not treat binary marker text in a hunk as metadata', () => {
    const raw = textDiff('markers.sql', 'GIT binary patch');
    expect(parseDiff(raw)).toHaveLength(1);
    expect(preprocessDiff(raw).processedDiff).toBe(raw);
  });

  it('preserves rename-only and mode-only text blocks exactly', () => {
    const renamed =
      'diff --git a/old schema.sql b/新 schema.sql\nsimilarity index 100%\nrename from old schema.sql\nrename to 新 schema.sql\n';
    const mode = 'diff --git a/script.sql b/script.sql\nold mode 100644\nnew mode 100755\n';
    const raw = renamed + binaryDiff(workbook) + mode;
    expect(parseDiff(raw).map((file) => file.path)).toEqual(['新 schema.sql', 'script.sql']);
    expect(preprocessDiff(raw).processedDiff).toBe(renamed + mode);
  });

  it('keeps deleted text paths as context without leaking text or binary deletion blocks', () => {
    const deleted =
      'diff --git a/会計 old.sql b/会計 old.sql\ndeleted file mode 100644\n--- a/会計 old.sql\n+++ /dev/null\n@@ -1 +0,0 @@\n-SELECT 1;\n';
    const binaryDeleted = `diff --git a/${workbook} b/${workbook}\ndeleted file mode 100644\nBinary files a/${workbook} and /dev/null differ\n`;
    const remaining = textDiff('current.sql');
    const result = preprocessDiff(deleted + binaryDeleted + remaining);
    expect(result.deletedFiles).toEqual(['会計 old.sql']);
    expect(result.processedDiff).toBe(remaining);
    expect(result.diffFiles.map((file) => file.path)).toEqual(['current.sql']);
    expect(result.stats.deletedFileCount).toBe(1);
  });
});
