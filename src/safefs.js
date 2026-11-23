// Filesystem helpers for touching paths a pod may have tampered with. The rules:
//   - never follow a symlink we didn't create (lstat, O_EXCL creates),
//   - replace files by rename (which swaps a planted symlink instead of writing through it),
//   - decide "inside a folder" on real paths, after resolving every symlink.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './ui.js';

// 'missing' | 'file' | 'dir' | 'symlink' | 'other' — without following a final symlink.
export function kind(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing';
    throw e;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'dir';
  return 'other';
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// realpath of `p`, or of its nearest existing ancestor joined with the missing tail.
export function realpathLoose(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Creates `dir` (and parents) owner-only, and refuses if it is, or has been swapped for, anything
// but a real directory.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (kind(dir) !== 'dir') throw new CliError(`${dir} is not a real directory (symlink?). Refusing to use it.`);
  fs.chmodSync(dir, 0o700);
}

// Writes `content` to `file` atomically with mode 0600: exclusive-create a random temp name next
// to it (never follows a pre-planted symlink), then rename over the target.
export function writeFileAtomic(file, content, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, mode); // exact mode, whatever the umask
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Opens `file` for writing as a brand-new file: removes whatever is there (a symlink is removed
// itself, not its target), then exclusive-creates. Returns the fd.
export function createExclusive(file, mode = 0o600) {
  if (kind(file) !== 'missing') fs.rmSync(file, { force: true });
  return fs.openSync(file, 'wx', mode);
}

// Reads a small regular file, refusing symlinks and anything oversized. Checks the opened
// descriptor, not the path: a pod can swap the path between a check and a read, for a FIFO that
// would block the launcher or a symlink to /dev/zero.
export function readRegularFile(file, maxBytes = 1024 * 1024) {
  const k = kind(file);
  if (k === 'missing') return null;
  if (k !== 'file') throw new CliError(`${file} is a ${k}, not a regular file. Refusing to read it.`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw new CliError(`${file} is a symlink, not a regular file. Refusing to read it.`);
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new CliError(`${file} is not a regular file. Refusing to read it.`);
    if (st.size > maxBytes) throw new CliError(`${file} is too large (${st.size} bytes).`);
    const buf = Buffer.alloc(maxBytes + 1);
    let len = 0;
    for (let n; len <= maxBytes && (n = fs.readSync(fd, buf, len, maxBytes + 1 - len, null)) > 0;) len += n;
    if (len > maxBytes) throw new CliError(`${file} is too large (more than ${maxBytes} bytes).`);
    return buf.subarray(0, len);
  } finally {
    fs.closeSync(fd);
  }
}
