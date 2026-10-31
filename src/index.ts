import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { loadNotes, staleMark } from "./notes.js";
import { parseC, parseCSharp, parseGo, parseJava, parsePy, parseRust, parseTs, type Parsed } from "./parse.js";

export const STORE = ".codemem";
const VERSION = 8; // bump when parse output changes, so cached entries get re-parsed
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|java|rs|c|h|cc|cpp|cxx|hh|hpp|hxx|cs)$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// build output and vendored dependencies (other people's code: on Kubernetes or MongoDB it's a third of the files)
const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "target", "obj", STORE]);
for (const d of ["vendor", "third_party", "thirdparty", "3rdparty"]) SKIP.add(d);
// test files and folders: tests/, jstests/, unittests/, testdata/, fixtures/, __tests__/, __mocks__/, C# MyApp.Tests/
const TEST =
  /(\.|\/)(test|spec)\.[^/]+$|(^|\/)(tests?|[\w-]*tests|testing|testdata|fixtures?|__\w+__)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$|_test\.go$|(^|\/)[^/]*\.Tests?\//;

// specs/names/symbols are parse output, cached by mtime+size (then hash); imports/external/uses are re-resolved
// whenever anything changed, so new or deleted target files are picked up
export interface FileEntry extends Parsed {
  hash: string;
  mtime: number;
  size: number;
  imports: string[]; // resolved repo-relative paths
  external: string[]; // package names
  uses: Record<string, string[]>; // imported file -> names this file takes from it
}
export interface Index {
  version: number;
  fingerprint?: string; // config files that change how imports resolve (go.mod, Cargo.toml, tsconfig), with mtimes
  files: Record<string, FileEntry>;
}
const CONFIG = /^(go\.mod|Cargo\.toml|(tsconfig.*|jsconfig)\.json)$/;

const storePath = (root: string, name: string) => join(root, STORE, name);

/** Whether a changed path (as fs.watch reports it, any separator) is a source file the index covers. */
export const isSource = (f: string) => CODE.test(f) && !f.split(/[\\/]/).some((part) => SKIP.has(part));

export function loadIndex(root: string): Index {
  const p = storePath(root, "index.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { version: VERSION, files: {} };
}

/** Repo-relative posix paths of all files, respecting .gitignore when the root is a git repo. */
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\n").filter((f) => f && !f.split("/").some((part) => SKIP.has(part)));
  } catch {
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    walk("");
    return files;
  }
}

function resolve(from: string, spec: string, known: Set<string>): string | undefined {
  const base = posix.join(from ? posix.dirname(from) : ".", spec);
  const stem = base.replace(/\.[mc]?jsx?$/, ""); // NodeNext style: "./a.js" points at a.ts
  return [base, ...EXTS.map((e) => stem + e), ...EXTS.map((e) => `${base}/index${e}`)].find((c) => known.has(c));
}

const packageName = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

const ancestors = (d: string): string[] => (d === "." ? [""] : [d, ...ancestors(posix.dirname(d))]);

function resolvePy(from: string, spec: string, known: Set<string>): string | undefined {
  const dots = spec.match(/^\.*/)![0].length;
  const rest = spec.slice(dots).replace(/\./g, "/");
  // absolute imports: like sys.path, try the file's own folder and each parent up to the root (a service folder is often
  // its own source root, e.g. ml-service/app.py doing `from config import x`), then src/
  const bases = dots
    ? [posix.join(posix.dirname(from), ...Array(dots - 1).fill(".."), rest)]
    : [...ancestors(posix.dirname(from)).map((d) => posix.join(d, rest)), `src/${rest}`];
  return bases
    .flatMap((b) => (rest ? [`${b}.py`, posix.join(b, "__init__.py")] : [posix.join(b, "__init__.py")]))
    .find((c) => known.has(c));
}

interface Ctx {
  known: Set<string>;
  byDir: Map<string, string[]>; // folder -> its source files
  byName: Map<string, string[]>; // file name -> paths with that name
  goMods: [string, string][]; // go.mod folder, module path; longest path first
  crates: [string, string][]; // Cargo.toml folder, library name (how other crates and the crate's own main.rs call it)
  tsPaths: TsPaths[]; // tsconfig*.json / jsconfig.json with baseUrl or paths; deepest folder first
}
interface TsPaths {
  dir: string; // the config's folder: it applies to files under it
  base: string; // what `paths` targets and bare imports are relative to: baseUrl, else the config's folder
  baseUrl: boolean;
  paths: [string, string[]][];
}

/** Candidate files for an aliased import like "@/lib/x", or undefined when no `paths` pattern matches. */
function aliasTargets(from: string, spec: string, ctx: Ctx): string[] | undefined {
  for (const c of ctx.tsPaths) {
    if (c.dir !== "." && !from.startsWith(`${c.dir}/`)) continue;
    for (const [pattern, targets] of c.paths) {
      if (pattern === "*") continue; // a catch-all matches every package too; fromBaseUrl covers the usual "*": ["src/*"]
      const star = pattern.indexOf("*");
      const [pre, post] = star < 0 ? [pattern, ""] : [pattern.slice(0, star), pattern.slice(star + 1)];
      const hit = star < 0 ? spec === pattern : spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length;
      if (hit) return targets.map((t) => posix.join(c.base, t.replace("*", spec.slice(pre.length, spec.length - post.length))));
    }
  }
}

/** A bare import that is a file under a config's baseUrl (CRA-style `import Button from "components/Button"`). */
const fromBaseUrl = (from: string, spec: string, ctx: Ctx) =>
  ctx.tsPaths.filter((c) => c.baseUrl && (c.dir === "." || from.startsWith(`${c.dir}/`))).map((c) => posix.join(c.base, spec));

/** Go: an import of this repo's module is a package = every non-test .go file in that folder. */
function resolveGo(spec: string, ctx: Ctx): string[] {
  const mod = ctx.goMods.find(([, m]) => spec === m || spec.startsWith(m + "/"));
  if (!mod) return [];
  const dir = posix.join(mod[0], spec.slice(mod[1].length + 1));
  return (ctx.byDir.get(dir) ?? []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
}

/** Java: "a.b.C" is the file ending in a/b/C.java under any source root (src/main/java/...); "a.b.*" is that folder. */
function resolveJava(spec: string, ctx: Ctx): string[] {
  const segs = spec.split(".");
  const find = (parts: string[]) => {
    const p = `${parts.join("/")}.java`;
    return ctx.byName.get(posix.basename(p))?.find((f) => f === p || f.endsWith(`/${p}`));
  };
  if (segs.at(-1) === "*") {
    const cls = find(segs.slice(0, -1)); // `import static a.b.C.*`
    if (cls) return [cls];
    const dir = segs.slice(0, -1).join("/");
    return [...ctx.byDir].filter(([d]) => d === dir || d.endsWith(`/${dir}`)).flatMap(([, fs]) => fs.filter((f) => f.endsWith(".java")));
  }
  const f = find(segs) ?? find(segs.slice(0, -1)); // the class, or the class of a static import `a.b.C.m`
  return f ? [f] : [];
}

/** Rust module folder: items of `src/a.rs` (or `src/a/mod.rs`) live in `src/a/`; lib.rs and main.rs are the crate root. */
const rsModDir = (f: string) => (/(^|\/)(lib|main|mod)\.rs$/.test(f) ? posix.dirname(f) : f.slice(0, -3));

function resolveRs(from: string, spec: string, ctx: Ctx): string | undefined {
  const { known } = ctx;
  const segs = spec.split("::");
  let base = rsModDir(from);
  let min = 1; // a plain `a::b` starts at a child module, never at this file
  const crate = ctx.crates.find(([, name]) => name === segs[0]); // `mysetup::run()` from main.rs or another crate
  if (crate && known.has(posix.join(crate[0], "src/lib.rs"))) {
    base = posix.join(crate[0], "src");
    segs.shift();
    min = 0;
  } else if (segs[0] === "crate") {
    const isRoot = (d: string) => known.has(posix.join(d, "lib.rs")) || known.has(posix.join(d, "main.rs"));
    base = ancestors(posix.dirname(from)).find(isRoot) ?? base;
    segs.shift();
    min = 0;
  } else if (segs[0] === "self" || segs[0] === "super") {
    while (segs[0] === "super") {
      base = posix.dirname(base);
      segs.shift();
    }
    if (segs[0] === "self") segs.shift();
    min = 0;
  }
  // longest prefix that is a module file: crate::a::b::C is C in a/b.rs, or in a.rs when b is an item
  for (let k = segs.length; k >= min; k--) {
    const p = posix.join(base, ...segs.slice(0, k));
    const files = [`${p}.rs`, posix.join(p, "mod.rs"), ...(k ? [] : [posix.join(p, "lib.rs"), posix.join(p, "main.rs")])];
    const found = files.find((c) => known.has(c));
    if (found) return found;
  }
}

/** C/C++: "x.h" next to the including file first; otherwise, and for <x.h>, the repo file ending in that path, the way an
 * include directory finds it. shortcut: with two such files the first wins; read the build's -I flags if that bites. */
function resolveC(from: string, spec: string, ctx: Ctx): string[] {
  const path = spec.replace(/^<(.*)>$/, "$1");
  const near = posix.join(posix.dirname(from), path);
  if (path === spec && ctx.known.has(near)) return [near];
  const hit = ctx.byName.get(posix.basename(path))?.find((f) => f === path || f.endsWith(`/${path}`));
  return hit ? [hit] : [];
}

/** The source file implementing header h: same name next to it, else the only file with that name in the repo. */
function implOf(h: string, ctx: Ctx): string | undefined {
  if (!/\.(h|hh|hpp|hxx)$/.test(h)) return undefined;
  const stem = h.replace(/\.\w+$/, "");
  const exts = [".c", ".cc", ".cpp", ".cxx"];
  const next = exts.map((e) => stem + e).find((c) => ctx.known.has(c));
  const anywhere = exts.flatMap((e) => ctx.byName.get(posix.basename(stem) + e) ?? []);
  if (next || anywhere.length <= 1) return next ?? anywhere[0];
  // several with that name: the one sharing the most trailing folders (include/llvm/IR/Function.h <-> lib/IR/Function.cpp)
  const dirs = posix.dirname(h).split("/").reverse();
  const shared = (c: string) => {
    const d = posix.dirname(c).split("/").reverse();
    let n = 0;
    while (n < d.length && d[n] === dirs[n]) n++;
    return n;
  };
  const [best, second] = anywhere.map((c) => [c, shared(c)] as const).sort((a, b) => b[1] - a[1]);
  return best[1] > second[1] ? best[0] : undefined;
}

type Lang = "ts" | "py" | "go" | "java" | "rs" | "c" | "cs";
const LANG_BY_EXT: Record<string, Lang> = { py: "py", go: "go", java: "java", rs: "rs", cs: "cs" };
for (const ext of ["c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx"]) LANG_BY_EXT[ext] = "c";
const langOf = (f: string): Lang => LANG_BY_EXT[f.slice(f.lastIndexOf(".") + 1)] ?? "ts";

function parse(lang: Lang, f: string, src: string): Parsed {
  if (lang === "py") return parsePy(src);
  if (lang === "go") return parseGo(src);
  if (lang === "java") return parseJava(src);
  if (lang === "rs") return parseRust(src);
  if (lang === "c") return parseC(src);
  if (lang === "cs") return parseCSharp(src);
  return parseTs(f, src);
}

function resolveSpec(lang: Lang, f: string, s: string, ctx: Ctx): string[] {
  const one = (r?: string) => (r ? [r] : []);
  if (lang === "py") return one(resolvePy(f, s, ctx.known));
  if (lang === "go") return resolveGo(s, ctx);
  if (lang === "java") return resolveJava(s, ctx);
  if (lang === "rs") return one(resolveRs(f, s, ctx));
  if (lang === "c") return resolveC(f, s, ctx);
  if (lang === "cs") return []; // namespaces are matched to files after every file is parsed
  if (s.startsWith(".")) return one(resolve(f, s, ctx.known));
  const candidates = [...(aliasTargets(f, s, ctx) ?? []), ...fromBaseUrl(f, s, ctx)];
  return one(candidates.map((c) => resolve("", c, ctx.known)).find(Boolean));
}

/** The package an unresolved import comes from, or undefined when it points into this repo. */
function externalOf(lang: Lang, f: string, s: string, ctx: Ctx): string | undefined {
  // an alias whose file is missing is still this repo's code, not a package named "@"
  if (lang === "ts") return s.startsWith(".") || aliasTargets(f, s, ctx) ? undefined : packageName(s);
  if (lang === "py") {
    // "pkg.func" won't resolve to a file; only call it external when the top-level package isn't local
    const top = s.split(".")[0];
    return top && !resolvePy(f, top, ctx.known) ? top : undefined;
  }
  if (lang === "go") {
    if (ctx.goMods.some(([, m]) => s === m || s.startsWith(m + "/"))) return undefined;
    const segs = s.split("/");
    return segs[0].includes(".") ? segs.slice(0, 3).join("/") : s; // github.com/a/b, or a std package like net/http
  }
  if (lang === "java") return s.split(".").slice(0, 2).join(".");
  if (lang === "c") return s.replace(/^<(.*)>$/, "$1").split("/")[0]; // <boost/asio.hpp> -> boost, <vector> -> vector
  if (lang === "cs") return undefined;
  const top = s.split("::")[0];
  return ["crate", "self", "super"].includes(top) ? undefined : top;
}

const push = (m: Map<string, string[]>, k: string, v: string) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

/** Incrementally re-index: unchanged files (same mtime and size) aren't even read; only changed content is re-parsed. */
export function update(root: string): { index: Index; parsed: number } {
  const old = loadIndex(root);
  const all = listFiles(root);
  const stats = new Map<string, Stats>();
  for (const f of all) {
    const st = CODE.test(f) ? statSync(join(root, f), { throwIfNoEntry: false }) : undefined;
    if (st?.isFile()) stats.set(f, st);
  }
  const files = [...stats.keys()];
  const fingerprint = all
    .filter((f) => CONFIG.test(posix.basename(f)))
    .map((f) => {
      const st = statSync(join(root, f), { throwIfNoEntry: false });
      return `${f}:${st?.mtimeMs}:${st?.size}`;
    })
    .join("|");
  const same = old.version === VERSION;
  const untouched = (f: string) => old.files[f]?.mtime === stats.get(f)!.mtimeMs && old.files[f].size === stats.get(f)!.size;
  // nothing changed: skip resolving and rewriting, which on a 30k-file repo costs more than the check
  if (same && old.fingerprint === fingerprint && files.length === Object.keys(old.files).length && files.every(untouched)) {
    if (!existsSync(storePath(root, "map.md"))) writeMap(root, old);
    return { index: old, parsed: 0 };
  }
  const ctx: Ctx = { known: new Set(files), byDir: new Map(), byName: new Map(), goMods: [], crates: [], tsPaths: [] };
  for (const f of files) {
    push(ctx.byDir, posix.dirname(f), f);
    push(ctx.byName, posix.basename(f), f);
  }
  for (const f of all.filter((f) => posix.basename(f) === "go.mod" && existsSync(join(root, f)))) {
    const m = readFileSync(join(root, f), "utf8").match(/^module\s+(\S+)/m);
    if (m) ctx.goMods.push([posix.dirname(f), m[1]]);
  }
  ctx.goMods.sort((a, b) => b[1].length - a[1].length);
  for (const f of all.filter((f) => posix.basename(f) === "Cargo.toml" && existsSync(join(root, f)))) {
    const toml = readFileSync(join(root, f), "utf8");
    const field = (section: string) => toml.match(new RegExp(`^\\[${section}\\][^[]*?^name\\s*=\\s*"([^"]+)"`, "m"))?.[1];
    const name = field("lib") ?? field("package");
    if (name) ctx.crates.push([posix.dirname(f), name.replace(/-/g, "_")]);
  }
  // shortcut: `extends` isn't followed; every tsconfig*.json is read on its own, which covers Vite's tsconfig.app.json
  for (const f of all.filter((f) => /^(tsconfig.*|jsconfig)\.json$/.test(posix.basename(f)) && existsSync(join(root, f)))) {
    const opts = ts.parseConfigFileTextToJson(f, readFileSync(join(root, f), "utf8")).config?.compilerOptions; // allows comments
    if (!opts?.baseUrl && !opts?.paths) continue;
    const dir = posix.dirname(f);
    const paths = Object.entries((opts.paths ?? {}) as Record<string, string[]>);
    ctx.tsPaths.push({ dir, base: posix.join(dir, opts.baseUrl ?? "."), baseUrl: !!opts.baseUrl, paths });
  }
  ctx.tsPaths.sort((a, b) => b.dir.length - a.dir.length);

  const index: Index = { version: VERSION, fingerprint, files: {} };
  const edited: string[] = []; // new files and files whose content changed
  for (const f of files) {
    const st = stats.get(f)!;
    const prev = old.files[f];
    let p: Parsed | undefined;
    let hash: string;
    if (same && untouched(f)) [p, hash] = [prev, prev.hash];
    else {
      const src = readFileSync(join(root, f), "utf8");
      hash = createHash("sha1").update(src).digest("hex");
      p = same && prev?.hash === hash ? prev : undefined; // touched but not edited (checkout, save without changes)
      if (!p) {
        p = parse(langOf(f), f, src);
        edited.push(f);
      }
    }
    const { specs, names, symbols, main, namespaces, refs } = p;
    const parsedPart = { specs, names, symbols, main, namespaces, refs };
    index.files[f] = { hash, mtime: st.mtimeMs, size: st.size, ...parsedPart, imports: [], external: [], uses: {} };
  }

  // Same files and configs as last time: only the edited files and the files around them (their folder, which is a
  // Go/Java package or a header next to its source, and whatever imports those) can resolve differently. The rest
  // keep last run's links, so one save in a 30k-file repo doesn't re-resolve all of it.
  // shortcut: a file elsewhere that starts using a name just added (C# namespace in another folder) is linked on the next
  // full run, which happens whenever a file is added or removed or a config changes.
  let redo: Set<string> | undefined;
  if (same && old.fingerprint === fingerprint && files.length === Object.keys(old.files).length && files.every((f) => old.files[f])) {
    redo = new Set();
    const importers = edited.length ? importersOf(old) : new Map<string, string[]>();
    for (const g of edited)
      for (const s of ctx.byDir.get(posix.dirname(g)) ?? []) {
        redo.add(s);
        for (const i of importers.get(s) ?? []) redo.add(i);
      }
    for (const f of files) {
      const o = old.files[f];
      if (!redo.has(f)) Object.assign(index.files[f], { imports: o.imports, external: o.external, uses: o.uses });
    }
  }

  const goPackages = new Map<string, string[][]>(); // Go file -> the files of each package it imports, linked below
  for (const f of files) {
    if (redo && !redo.has(f)) continue;
    const p = index.files[f];
    const lang = langOf(f);
    const imports = new Set<string>();
    const external = new Set<string>();
    const uses: Record<string, string[]> = {};
    const localTops = new Set<string>(); // namespace packages (no __init__.py) are local once any submodule resolves
    for (const s of p.specs) {
      const targets = resolveSpec(lang, f, s, ctx);
      if (lang === "go" && targets.length) {
        goPackages.set(f, [...(goPackages.get(f) ?? []), targets]);
        continue;
      }
      for (const r of targets) {
        if (r === f) continue;
        imports.add(r);
        for (const n of p.names[s] ?? []) if (!(uses[r] ??= []).includes(n)) uses[r].push(n);
      }
      if (targets.length && lang === "py") localTops.add(s.split(".")[0]);
      const ext = targets.length ? undefined : externalOf(lang, f, s, ctx);
      if (ext) external.add(ext);
    }
    for (const t of localTops) external.delete(t);
    Object.assign(p, { imports: [...imports].sort(), external: [...external].sort(), uses });
  }

  // Links no import line states: Go/Java files use their package (folder), C/C++ files use the source behind an
  // included header, C# files use the files of every namespace in view, and a Go import reaches only the files of that
  // package defining what's used (not all 50 files of it). Only names the file mentions count.
  const nsFiles = new Map<string, string[]>();
  for (const [f, e] of Object.entries(index.files)) for (const ns of e.namespaces ?? []) push(nsFiles, ns, f);
  for (const [f, e] of Object.entries(index.files)) {
    if (redo && !redo.has(f)) continue;
    const lang = langOf(f);
    const mentioned = new Set(e.refs ?? e.symbols.flatMap((s) => s.calls ?? []));
    const imports = new Set(e.imports);
    const link = (g: string, names?: string[]) => {
      if (g === f) return false;
      // a class counts when g defines its methods: Foo::bar in foo.cpp implements Foo declared in foo.h
      const used = names ?? [...new Set(index.files[g].symbols.map((s) => s.parent ?? s.name))].filter((n) => mentioned.has(n));
      if (!used.length) return false;
      imports.add(g);
      e.uses[g] = [...new Set([...(e.uses[g] ?? []), ...used])];
      return true;
    };
    if (lang === "go" || lang === "java") {
      for (const g of ctx.byDir.get(posix.dirname(f)) ?? []) if (posix.extname(g) === posix.extname(f)) link(g);
      // a package used only for its consts/vars (not indexed) still counts as imported, as a whole
      for (const pkg of goPackages.get(f) ?? []) if (!pkg.map((g) => link(g)).some(Boolean)) for (const g of pkg) link(g, ["*"]);
    } else if (lang === "c") {
      for (const h of [...e.imports]) {
        const impl = implOf(h, ctx);
        if (impl) link(impl);
      }
    } else if (lang === "cs") {
      // in view: the file's own namespaces and their parents, plus every `using`
      const inView = new Set<string>();
      for (const ns of e.namespaces ?? []) for (let n = ns; n; n = n.slice(0, Math.max(0, n.lastIndexOf(".")))) inView.add(n);
      const external = new Set<string>();
      for (const s of e.specs) {
        const parent = s.includes(".") ? s.slice(0, s.lastIndexOf(".")) : "";
        // `using static A.B.C;` / `using X = A.B.C;` name a type, whose namespace is A.B
        const ns = nsFiles.has(s) ? s : nsFiles.has(parent) ? parent : undefined;
        if (ns) inView.add(ns);
        else external.add(s.split(".").slice(0, 2).join("."));
      }
      e.external = [...external].sort();
      for (const ns of inView) for (const g of nsFiles.get(ns) ?? []) link(g);
    }
    e.imports = [...imports].sort();
  }
  // a few files re-saved unchanged: re-hashing them next time is cheaper than rewriting a 100MB+ index now
  const touched = files.filter((f) => !untouched(f)).length;
  if (redo?.size === 0 && touched <= 200) return { index, parsed: 0 };
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(storePath(root, "index.json"), JSON.stringify(index)); // compact: it's a cache, often 100MB+ on big repos
  if (!redo || redo.size) writeMap(root, index); // files only re-saved unchanged: the map can't have changed
  return { index, parsed: edited.length };
}

export function importersOf(index: Index): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [f, e] of Object.entries(index.files)) for (const i of e.imports) push(m, i, f);
  return m;
}

/** The file that defines top-level `name` as seen from `file`: itself, or a local file it imports the name from,
 * following re-exports (barrel index files, `export *`). Undefined for names from external packages. */
export function definedIn(index: Index, file: string, name: string, depth = 0): string | undefined {
  const e = index.files[file];
  if (!e) return undefined;
  if (e.symbols.some((s) => s.name === name && !s.parent)) return file;
  if (depth > 5) return undefined;
  for (const [target, names] of Object.entries(e.uses))
    if (names.includes(name) || names.includes("*")) {
      const found = definedIn(index, target, name, depth + 1);
      if (found) return found;
    }
  return undefined;
}

/** A symbol's calls resolved to local files; names from external packages are dropped. */
export const resolvedCalls = (index: Index, file: string, calls: string[] = []) =>
  calls.flatMap((name) => {
    const at = definedIn(index, file, name);
    return at ? [{ name, file: at }] : [];
  });

/** package.json main/bin/exports targets, plus non-test source files nothing imports. */
export function entryPoints(root: string, index: Index): string[] {
  const known = new Set(Object.keys(index.files));
  const found = new Set<string>();
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const targets: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") targets.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    [pkg.main, pkg.module, pkg.bin, pkg.exports].forEach(collect);
    for (const t of targets) {
      const rel = posix.normalize(t);
      // build output usually mirrors src/, e.g. dist/cli.js -> src/cli.ts
      const r = resolve("", rel, known) ?? resolve("", rel.replace(/^(dist|build|lib|out)\/(src\/)?/, "src/"), known);
      if (r) found.add(r);
    }
  }
  const importers = importersOf(index);
  // "nothing imports it" only means something where files import files. A .c/.cpp file is compiled, never included,
  // and a Go/Java/C# file belongs to its package: those count only with a main. __init__.py runs when its package does.
  const fileImports = (f: string) => ["ts", "py", "rs"].includes(langOf(f));
  for (const f of known) if (!importers.has(f) && fileImports(f) && !TEST.test(f) && !f.endsWith("__init__.py")) found.add(f);
  // a file that runs on its own stays an entry point even when another file imports it back for its helpers
  for (const [f, e] of Object.entries(index.files)) {
    const hasMain = e.symbols.some(
      (s) => (s.name === "main" && (!s.parent || f.endsWith(".java"))) || (s.name === "Main" && f.endsWith(".cs")),
    );
    if (!TEST.test(f) && (e.main || hasMain)) found.add(f);
  }
  return [...found].sort();
}

const MAP_BUDGET = 40_000; // chars (~10k tokens): the map is read whole by agents, so a big repo gets a coarser one
const ENTRY_LIMIT = 60;

/** Modules section, one line per file, or per folder (first `depth` path parts) with the folders it depends on. */
function modulesSection(index: Index, files: string[], depth?: number): string[] {
  const lines: string[] = [];
  if (depth === undefined) {
    let dir: string | undefined;
    for (const f of files) {
      const d = posix.dirname(f);
      if (d !== dir) lines.push("", `### ${d === "." ? "(root)" : d + "/"}`);
      dir = d;
      const e = index.files[f];
      const deps = [...e.imports, ...e.external.map((x) => `pkg:${x}`)];
      lines.push(`- \`${f}\`${deps.length ? ` → ${deps.join(", ")}` : ""}`);
      const defs = e.symbols.filter((s) => !s.parent && s.kind !== "const");
      if (defs.length) lines.push(`  - defines: ${defs.map((s) => (s.kind === "class" ? `class ${s.name}` : s.name)).join(", ")}`);
    }
    return lines;
  }
  const folderOf = new Map(files.map((f) => [f, posix.dirname(f).split("/").slice(0, depth).join("/").replace(/^\.$/, "(root)")]));
  const groups = new Map<string, { files: number; deps: Map<string, number> }>();
  for (const f of files) {
    const own = folderOf.get(f)!;
    const g = groups.get(own) ?? { files: 0, deps: new Map() };
    groups.set(own, g);
    g.files++;
    const e = index.files[f];
    for (const d of [...new Set(e.imports.map((i) => `${folderOf.get(i)}/`))].concat(e.external.map((x) => `pkg:${x}`)))
      if (d !== `${own}/`) g.deps.set(d, (g.deps.get(d) ?? 0) + 1);
  }
  lines.push("", `_Grouped by folder (first ${depth} levels): this repo is too big to list every file. Ask \`get_context\` for a folder._`, "");
  for (const [name, g] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const top = [...g.deps].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d);
    const more = g.deps.size > top.length ? `, +${g.deps.size - top.length} more` : "";
    lines.push(`- \`${name}/\` (${g.files} files)${top.length ? ` → ${top.join(", ")}${more}` : ""}`);
  }
  return lines;
}

export function renderMap(root: string, index = loadIndex(root)): string {
  // by folder, then name, so each folder heading appears once (plain path order splits "main.py" from "config.py")
  const files = Object.keys(index.files).sort((a, b) => {
    const [da, db] = [posix.dirname(a), posix.dirname(b)];
    return da === db ? (a < b ? -1 : 1) : da < db ? -1 : 1;
  });
  const importers = importersOf(index);
  const notes = loadNotes(root);
  const entries = entryPoints(root, index);
  const lines = [
    "# Codebase map",
    "",
    `_${files.length} source files. Generated by codemem; do not edit. Add notes with \`codemem note add\`._`,
    "",
    "## Entry points",
    ...entries.slice(0, ENTRY_LIMIT).map((f) => `- \`${f}\``),
    ...(entries.length > ENTRY_LIMIT ? [`- …and ${entries.length - ENTRY_LIMIT} more (files nothing imports)`] : []),
    "",
    "## Most depended-on",
    ...[...importers]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([f, by]) => `- \`${f}\` (${by.length} importers)`),
  ];
  if (notes.length) {
    lines.push("", "## Notes");
    for (const n of notes)
      lines.push(`- #${n.id} [${n.kind}] ${n.title}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}${staleMark(root, n)}`);
  }
  lines.push("", "## Modules");
  const head = lines.join("\n");
  // the most detail that fits: every file, else folders as deep as the budget allows (deeper = longer, so bisect)
  const fits = (s: string) => head.length + s.length <= MAP_BUDGET;
  // a file line is ~40+ chars, so past budget/40 files listing them all can't fit; don't build it
  let body = files.length * 40 <= MAP_BUDGET ? modulesSection(index, files).join("\n") : "";
  if (!body || !fits(body)) {
    let [lo, hi] = [1, files.reduce((d, f) => Math.max(d, f.split("/").length - 1), 1)];
    body = modulesSection(index, files, 1).join("\n");
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const s = modulesSection(index, files, mid).join("\n");
      if (fits(s)) [lo, body] = [mid, s];
      else hi = mid - 1;
    }
  }
  return `${head}\n${body}\n`;
}

export function writeMap(root: string, index?: Index): void {
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(storePath(root, "map.md"), renderMap(root, index));
}
