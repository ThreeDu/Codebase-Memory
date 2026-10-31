import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "";

/** Write through a temp file and a rename, so another process (a second agent, `codemem watch`) never reads a
 * half-written file. */
export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  // Windows won't replace a file another program holds open without delete sharing (antivirus, editors): retry briefly
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(tmp, path);
    } catch (e) {
      if (attempt >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(code(e))) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleep(50);
    }
  }
}

/** Run fn holding `<path>.lock`, so read-modify-write from two processes (two agents adding notes) loses nothing. */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let waited = 0; ; waited += 25) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 10_000) rmSync(lock, { force: true }); // left behind by a process that crashed while holding it
      else if (waited > 10_000) throw new Error(`${lock} is held by another process; delete it if no codemem is running`);
      else sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
