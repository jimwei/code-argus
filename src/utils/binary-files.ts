/** File formats whose contents are not suitable for text review. */
const BINARY_EXTENSIONS: Record<string, true> = {
  xls: true,
  xlsx: true,
  xlsm: true,
  xlsb: true,
  xlt: true,
  xltx: true,
  xltm: true,
  doc: true,
  docx: true,
  docm: true,
  dotx: true,
  ppt: true,
  pptx: true,
  pptm: true,
  pps: true,
  ppsx: true,
  odt: true,
  ods: true,
  odp: true,
  pdf: true,
  zip: true,
  tar: true,
  gz: true,
  tgz: true,
  bz2: true,
  xz: true,
  '7z': true,
  rar: true,
  zst: true,
  cab: true,
  iso: true,
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  bmp: true,
  ico: true,
  webp: true,
  avif: true,
  tif: true,
  tiff: true,
  heic: true,
  psd: true,
  woff: true,
  woff2: true,
  ttf: true,
  otf: true,
  eot: true,
  mp3: true,
  mp4: true,
  m4a: true,
  m4v: true,
  wav: true,
  ogg: true,
  flac: true,
  aac: true,
  avi: true,
  mov: true,
  webm: true,
  mkv: true,
  exe: true,
  dll: true,
  so: true,
  dylib: true,
  o: true,
  obj: true,
  a: true,
  lib: true,
  class: true,
  jar: true,
  war: true,
  wasm: true,
  pyc: true,
  pyo: true,
  bin: true,
  db: true,
  sqlite: true,
  sqlite3: true,
};

export function isBinaryPath(path: string): boolean {
  const fileName = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = fileName.lastIndexOf('.');
  return (
    dot >= 0 &&
    Object.prototype.hasOwnProperty.call(BINARY_EXTENSIONS, fileName.slice(dot + 1).toLowerCase())
  );
}

/** Inspect all supplied content; non-ASCII text is not evidence of binary data. */
export function isBinaryContent(content: string | Uint8Array): boolean {
  const length = content.length;
  for (let index = 0; index < length; index++) {
    const code = typeof content === 'string' ? content.charCodeAt(index) : content[index]!;
    // Tabs, newlines, carriage returns and form feeds are normal text whitespace.
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)) {
      return true;
    }
    if (code === 127) {
      return true;
    }
  }
  return false;
}

export function isBinaryDiff(content: string): boolean {
  if (isBinaryContent(content)) {
    return true;
  }
  // Only metadata lines count: added/removed/context lines may quote these strings.
  return /^(?:Binary files .+ differ|GIT binary patch)\r?$/m.test(content);
}
