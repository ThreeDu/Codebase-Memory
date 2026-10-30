import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { loadNotes } from "./notes.js";

export const STORE = ".codemem";
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", STORE]);
const TEST = /(\.|\/)(test|spec)\.[^/]+$|(^|\/)(__tests__|tests?)\//;

export interface FileEntry {
  hash: string;
  specs: string[]; // raw import specifiers; re-resolved every run so new/deleted targets are picked up
  imports: string[]; // resolved repo-relative paths
  external: string[]; // package names
}
export interface Index {
  version: 1;
  files: Record<string, FileEntry>;
}

const storePath = (root: string, name: string) => join(root, STORE, name);

export function loadIndex(root: string): Index {
  const p = storePath(root, "index.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { version: 1, files: {} };
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

/** Incrementally re-index: only files whose content hash changed are re-parsed. */
export function update(root: string): { index: Index; parsed: number } {
  const old = loadIndex(root);
  const files = listFiles(root).filter((f) => CODE.test(f) && existsSync(join(root, f)));
  const known = new Set(files);
  const index: Index = { version: 1, files: {} };
  let parsed = 0;
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    const hash = createHash("sha1").update(src).digest("hex");
    let specs = old.files[f]?.hash === hash ? old.files[f].specs : undefined;
    if (!specs) {
      specs = [...new Set(ts.preProcessFile(src, true, true).importedFiles.map((i) => i.fileName))];
      parsed++;
    }
    const imports = new Set<string>();
    const external = new Set<string>();
    for (const s of specs) {
      // shortcut: tsconfig "paths" aliases land in external; resolve them when a target repo needs it.
      if (s.startsWith(".")) {
        const r = resolve(f, s, known);
        if (r) imports.add(r);
      } else external.add(packageName(s));
    }
    index.files[f] = { hash, specs, imports: [...imports].sort(), external: [...external].sort() };
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
  for (const f of known) if (!importers.has(f) && !TEST.test(f)) found.add(f);
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
    for (const n of notes) lines.push(`- [${n.kind}] ${n.title}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}`);
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
  }
  return lines.join("\n") + "\n";
}

export function writeMap(root: string, index?: Index): void {
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(storePath(root, "map.md"), renderMap(root, index));
}
