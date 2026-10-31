import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { loadNotes, staleMark } from "./notes.js";
import { parseGo, parseJava, parsePy, parseRust, parseTs, type Parsed } from "./parse.js";

export const STORE = ".codemem";
const VERSION = 5; // bump when parse output changes, so cached entries get re-parsed
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|java|rs)$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "target", STORE]);
const TEST = /(\.|\/)(test|spec)\.[^/]+$|(^|\/)(__tests__|tests?)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$|_test\.go$/;

// specs/names/symbols are parse output, cached by hash; imports/external/uses are re-resolved every run
// so new or deleted target files are picked up
export interface FileEntry extends Parsed {
  hash: string;
  imports: string[]; // resolved repo-relative paths
  external: string[]; // package names
  uses: Record<string, string[]>; // imported file -> names this file takes from it
}
export interface Index {
  version: number;
  files: Record<string, FileEntry>;
}

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
}

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

function resolveRs(from: string, spec: string, known: Set<string>): string | undefined {
  const segs = spec.split("::");
  let base = rsModDir(from);
  let min = 1; // a plain `a::b` starts at a child module, never at this file
  if (segs[0] === "crate") {
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

type Lang = "ts" | "py" | "go" | "java" | "rs";
const langOf = (f: string) => (f.match(/\.(py|go|java|rs)$/)?.[1] ?? "ts") as Lang;

function parse(lang: Lang, f: string, src: string): Parsed {
  if (lang === "py") return parsePy(src);
  if (lang === "go") return parseGo(src);
  if (lang === "java") return parseJava(src);
  if (lang === "rs") return parseRust(src);
  return parseTs(f, src);
}

function resolveSpec(lang: Lang, f: string, s: string, ctx: Ctx): string[] {
  const one = (r?: string) => (r ? [r] : []);
  if (lang === "py") return one(resolvePy(f, s, ctx.known));
  if (lang === "go") return resolveGo(s, ctx);
  if (lang === "java") return resolveJava(s, ctx);
  if (lang === "rs") return one(resolveRs(f, s, ctx.known));
  // shortcut: tsconfig "paths" aliases land in external; resolve them when a target repo needs it.
  return s.startsWith(".") ? one(resolve(f, s, ctx.known)) : [];
}

/** The package an unresolved import comes from, or undefined when it points into this repo. */
function externalOf(lang: Lang, f: string, s: string, ctx: Ctx): string | undefined {
  if (lang === "ts") return s.startsWith(".") ? undefined : packageName(s);
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
  const top = s.split("::")[0];
  return ["crate", "self", "super"].includes(top) ? undefined : top;
}

const push = (m: Map<string, string[]>, k: string, v: string) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

/** Incrementally re-index: only files whose content hash changed are re-parsed. */
export function update(root: string): { index: Index; parsed: number } {
  const old = loadIndex(root);
  const all = listFiles(root);
  const files = all.filter((f) => CODE.test(f) && existsSync(join(root, f)));
  const ctx: Ctx = { known: new Set(files), byDir: new Map(), byName: new Map(), goMods: [] };
  for (const f of files) {
    push(ctx.byDir, posix.dirname(f), f);
    push(ctx.byName, posix.basename(f), f);
  }
  for (const f of all.filter((f) => posix.basename(f) === "go.mod" && existsSync(join(root, f)))) {
    const m = readFileSync(join(root, f), "utf8").match(/^module\s+(\S+)/m);
    if (m) ctx.goMods.push([posix.dirname(f), m[1]]);
  }
  ctx.goMods.sort((a, b) => b[1].length - a[1].length);

  const index: Index = { version: VERSION, files: {} };
  let parsed = 0;
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    const hash = createHash("sha1").update(src).digest("hex");
    const prev = old.files[f];
    const lang = langOf(f);
    let p: Parsed | undefined = old.version === VERSION && prev?.hash === hash ? prev : undefined;
    if (!p) {
      p = parse(lang, f, src);
      parsed++;
    }
    const imports = new Set<string>();
    const external = new Set<string>();
    const uses: Record<string, string[]> = {};
    const localTops = new Set<string>(); // namespace packages (no __init__.py) are local once any submodule resolves
    for (const s of p.specs) {
      const targets = resolveSpec(lang, f, s, ctx);
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
    const { specs, names, symbols } = p;
    index.files[f] = { hash, specs, names, symbols, imports: [...imports].sort(), external: [...external].sort(), uses };
  }

  // Go and Java files use the rest of their package (folder) without importing it
  for (const [f, e] of Object.entries(index.files)) {
    if (!/\.(go|java)$/.test(f)) continue;
    const called = new Set(e.symbols.flatMap((s) => s.calls ?? []));
    for (const g of ctx.byDir.get(posix.dirname(f)) ?? []) {
      if (g === f || posix.extname(g) !== posix.extname(f)) continue;
      const used = index.files[g].symbols.filter((s) => !s.parent && called.has(s.name)).map((s) => s.name);
      if (!used.length) continue;
      e.imports = [...new Set([...e.imports, g])].sort();
      e.uses[g] = [...new Set([...(e.uses[g] ?? []), ...used])];
    }
  }
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(storePath(root, "index.json"), JSON.stringify(index, null, 1));
  writeMap(root, index);
  return { index, parsed };
}

export function importersOf(index: Index): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [f, e] of Object.entries(index.files))
    for (const i of e.imports) m.set(i, [...(m.get(i) ?? []), f]);
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
  // __init__.py runs when its package is imported, never on its own
  for (const f of known) if (!importers.has(f) && !TEST.test(f) && !f.endsWith("__init__.py")) found.add(f);
  return [...found].sort();
}

export function renderMap(root: string, index = loadIndex(root)): string {
  const files = Object.keys(index.files).sort();
  const importers = importersOf(index);
  const notes = loadNotes(root);
  const lines = [
    "# Codebase map",
    "",
    `_${files.length} source files. Generated by codemem; do not edit. Add notes with \`codemem note add\`._`,
    "",
    "## Entry points",
    ...entryPoints(root, index).map((f) => `- \`${f}\``),
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
  return lines.join("\n") + "\n";
}

export function writeMap(root: string, index?: Index): void {
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(storePath(root, "map.md"), renderMap(root, index));
}
