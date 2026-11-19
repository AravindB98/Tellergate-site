// A small in-memory file system for Go's js/wasm port, so TellerGate's own
// audit, policy and principal packages can read and write files in the
// browser. It implements the subset of Node's callback fs API that Go's
// syscall package calls. Load it before wasm_exec.js.
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const files = new Map();          // path -> Uint8Array
  const dirs = new Set(["/"]);
  const fds = new Map();            // fd -> {path, pos, append}
  let nextFd = 10, outBuf = "";
  const C = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_DIRECTORY: 65536 };
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  const parent = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  const stat = (path) => {
    const isDir = dirs.has(path), data = files.get(path);
    if (!isDir && !data) return null;
    const now = Date.now();
    return { dev: 0, ino: 0, mode: isDir ? 0o40755 : 0o100600, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size: isDir ? 0 : data.length, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
      isDirectory: () => isDir };
  };
  const flushOut = (s) => { outBuf += s; const i = outBuf.lastIndexOf("\n"); if (i >= 0) { console.log(outBuf.slice(0, i)); outBuf = outBuf.slice(i + 1); } };
  const fs = {
    constants: C,
    writeSync(fd, buf) {
      if (fd === 1 || fd === 2) { flushOut(dec.decode(buf)); return buf.length; }
      throw err("EBADF");
    },
    write(fd, buf, offset, length, position, cb) {
      if (fd === 1 || fd === 2) { flushOut(dec.decode(buf.subarray(offset, offset + length))); return cb(null, length); }
      const f = fds.get(fd); if (!f) return cb(err("EBADF"));
      const cur = files.get(f.path) || new Uint8Array(0);
      const at = f.append ? cur.length : (position ?? f.pos);
      const out = new Uint8Array(Math.max(cur.length, at + length));
      out.set(cur); out.set(buf.subarray(offset, offset + length), at);
      files.set(f.path, out);
      if (position == null) f.pos = at + length;
      cb(null, length);
    },
    read(fd, buf, offset, length, position, cb) {
      const f = fds.get(fd); if (!f) return cb(err("EBADF"));
      const data = files.get(f.path) || new Uint8Array(0);
      const at = position ?? f.pos;
      const chunk = data.subarray(at, Math.min(data.length, at + length));
      buf.set(chunk, offset);
      if (position == null) f.pos = at + chunk.length;
      cb(null, chunk.length);
    },
    open(path, flags, mode, cb) {
      const exists = files.has(path) || dirs.has(path);
      if (!exists && !(flags & C.O_CREAT)) return cb(err("ENOENT"));
      if (exists && (flags & C.O_CREAT) && (flags & C.O_EXCL)) return cb(err("EEXIST"));
      if (!exists) { if (!dirs.has(parent(path))) return cb(err("ENOENT")); files.set(path, new Uint8Array(0)); }
      if (flags & C.O_TRUNC) files.set(path, new Uint8Array(0));
      const fd = nextFd++;
      fds.set(fd, { path, pos: 0, append: !!(flags & C.O_APPEND) });
      cb(null, fd);
    },
    close(fd, cb) { fds.delete(fd); cb(null); },
    fsync(fd, cb) { cb(null); },
    fstat(fd, cb) { const f = fds.get(fd); const s = f && stat(f.path); s ? cb(null, s) : cb(err("EBADF")); },
    stat(path, cb) { const s = stat(path); s ? cb(null, s) : cb(err("ENOENT")); },
    lstat(path, cb) { fs.stat(path, cb); },
    mkdir(path, perm, cb) { if (dirs.has(path) || files.has(path)) return cb(err("EEXIST")); dirs.add(path); cb(null); },
    unlink(path, cb) { files.delete(path) ? cb(null) : cb(err("ENOENT")); },
    readdir(path, cb) { const pre = path === "/" ? "/" : path + "/"; cb(null, [...files.keys(), ...dirs].filter(p => p !== path && p.startsWith(pre) && !p.slice(pre.length).includes("/")).map(p => p.slice(pre.length))); },
    rename(a, b, cb) { if (!files.has(a)) return cb(err("ENOENT")); files.set(b, files.get(a)); files.delete(a); cb(null); },
    ftruncate(fd, len, cb) { const f = fds.get(fd); if (!f) return cb(err("EBADF")); files.set(f.path, (files.get(f.path) || new Uint8Array(0)).slice(0, len)); cb(null); },
    truncate(path, len, cb) { if (!files.has(path)) return cb(err("ENOENT")); files.set(path, files.get(path).slice(0, len)); cb(null); },
  };
  for (const n of ["chmod", "fchmod", "chown", "fchown", "lchown", "utimes", "link", "symlink", "readlink", "rmdir"]) fs[n] = (...a) => a[a.length - 1](err("ENOSYS"));
  globalThis.fs = fs;
  // Page-side helpers (not used by Go).
  globalThis.memfs = {
    mkdir: (p) => dirs.add(p),
    writeText: (p, s) => files.set(p, enc.encode(s)),
    readText: (p) => files.has(p) ? dec.decode(files.get(p)) : "",
    remove: (p) => files.delete(p),
  };
})();
