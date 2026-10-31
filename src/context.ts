import { readFileSync } from "node:fs";
import { join } from "node:path";
import { definedIn, importersOf, resolvedCalls, update, type Index } from "./index.js";
import { loadNotes, normalizePath, staleMark } from "./notes.js";
import type { Sym } from "./parse.js";

const within = (file: string, path: string) => file === path || file.startsWith(path + "/");
const withNames = (file: string, names?: string[]) => (names?.length ? `${file} (${names.join(", ")})` : file);

/** Definitions of `name` or `Class.method`, as [file, symbol]. */
function matches(index: Index, query: string): [string, Sym][] {
  const [cls, name] = query.includes(".") ? query.split(".", 2) : [undefined, query];
  return Object.entries(index.files).flatMap(([f, e]) =>
    e.symbols.filter((s) => s.name === name && (cls === undefined || s.parent === cls)).map((s): [string, Sym] => [f, s]),
  );
}

/** Where a function/class (or `Class.method`) is defined and which files and functions use it. */
function symbolLines(index: Index, query: string): string[] {
  const out: string[] = [];
  for (const [f, s] of matches(index, query)) {
    const e = index.files[f];
    const name = s.name;
    out.push(`- ${s.kind} \`${s.parent ? `${s.parent}.` : ""}${s.name}\` defined at \`${f}:${s.line}\``);
    if (s.kind === "class") {
      const methods = e.symbols.filter((m) => m.parent === s.name).map((m) => m.name);
      if (methods.length) out.push(`  - methods: ${methods.join(", ")}`);
    }
    if (s.parent) continue; // shortcut: method calls through instances (obj.method()) aren't tracked
    for (const [g, ge] of Object.entries(index.files)) {
      if (definedIn(index, g, name) !== f) continue;
      const callers = ge.symbols.filter((x) => x.calls?.includes(name) && x !== s);
      const imported = g !== f && Object.values(ge.uses).some((n) => n.includes(name) || n.includes("*"));
      if (!callers.length && !imported) continue;
      const where = callers.map((x) => (x.parent ? `${x.parent}.${x.name}` : x.name)).join(", ");
      out.push(`  - used by \`${g}\`${where ? ` in: ${where}` : ""}`);
    }
  }
  return out;
}

// shortcut: every query re-hashes all files so answers are never stale; add a file watcher if that gets slow on big repos.
const fresh = (root: string) => update(root).index;

export function findSymbol(root: string, name: string): string {
  const lines = symbolLines(fresh(root), name.trim());
  return lines.length ? [`# Symbol: ${name}`, "", ...lines].join("\n") : `No function or class named \`${name}\`.`;
}

/** The source of a function/class/method, so an agent can read just that instead of the whole file. */
export function readSymbol(root: string, name: string): string {
  const found = matches(fresh(root), name.trim());
  if (!found.length) return `No function or class named \`${name}\`.`;
  return found
    .map(([f, s]) => {
      const lines = readFileSync(join(root, f), "utf8").split(/\r?\n/);
      const end = s.end ?? s.line;
      return `## \`${f}:${s.line}-${end}\`\n\n\`\`\`\n${lines.slice(s.line - 1, end).join("\n")}\n\`\`\``;
    })
    .join("\n\n");
}

/**
 * Selective context for one task: target is a file, a folder, a symbol name, or a keyword.
 * Returns the matching notes plus the matched files with their symbols and 1-hop neighbours, cut to `budget` chars.
 */
export function context(root: string, target: string, budget = 8000): string {
  const index = fresh(root);
  const files = Object.keys(index.files).sort();
  if (!files.length) return "No supported source files found.";

  const t = normalizePath(target);
  const kw = t.toLowerCase();
  let matched = files.filter((f) => within(f, t));
  const symbols = matched.length ? [] : symbolLines(index, t);
  if (!matched.length) matched = files.filter((f) => f.toLowerCase().includes(kw));

  const notes = loadNotes(root).filter(
    (n) =>
      n.paths.some((p) => within(t, p) || within(p, t) || matched.some((f) => within(f, p))) ||
      `${n.title}\n${n.body}`.toLowerCase().includes(kw),
  );

  const importers = importersOf(index);
  const out = [`# Context: ${target}`, ""];
  if (notes.length) {
    out.push("## Notes");
    for (const n of notes)
      out.push(`### #${n.id} [${n.kind}] ${n.title} (${n.date}${n.paths.length ? `; ${n.paths.join(", ")}` : ""})${staleMark(root, n)}`, n.body, "");
  }
  if (symbols.length) out.push("## Symbols", ...symbols, "");
  out.push(`## Files (${matched.length})`);
  for (const f of matched) {
    const e = index.files[f];
    out.push(`- \`${f}\``);
    if (e.imports.length) out.push(`  - imports: ${e.imports.map((i) => withNames(i, e.uses[i])).join(", ")}`);
    if (e.external.length) out.push(`  - packages: ${e.external.join(", ")}`);
    const by = importers.get(f);
    if (by?.length) out.push(`  - imported by: ${by.map((g) => withNames(g, index.files[g].uses[f])).join(", ")}`);
    if (e.symbols.length) out.push("  - defines:");
    for (const s of e.symbols) {
      const calls = resolvedCalls(index, f, s.calls).map((c) => (c.file === f ? c.name : `${c.name} (${c.file})`));
      out.push(
        `${s.parent ? "      " : "    "}- ${s.kind} \`${s.name}\` :${s.line}${s.exported ? " (exported)" : ""}` +
          (calls.length ? ` → ${calls.join(", ")}` : ""),
      );
    }
  }
  if (!matched.length && !symbols.length) out.push("_No files matched._");

  const text = out.join("\n");
  return text.length <= budget ? text : `${text.slice(0, budget)}\n…(truncated ${text.length - budget} chars; narrow the target)`;
}
