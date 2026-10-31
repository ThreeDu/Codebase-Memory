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

/** "handlePaymentWebhook", "handle_payment_webhook", "HTTPServer" -> ["handle", "payment", "webhook"], ["http", "server"] */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Functions, classes and methods matching a rough name or a few words ("payment webhook", "parseConfig"), best first.
 * Every query word must match a word of the name or its class (exactly, as a prefix either way, or inside it); file path
 * words only add weight. For when the exact name isn't known; find_symbol / read_symbol take it from there. */
export function searchSymbols(root: string, query: string, limit = 20): string {
  const index = fresh(root);
  const q = words(query);
  if (!q.length) return "Give a name or a few words to search for.";
  const whole = q.join("");
  const hits: { score: number; label: string; at: string; s: Sym }[] = [];
  for (const [f, e] of Object.entries(index.files)) {
    let path: string[] | undefined; // only split when a name matched, most never do
    for (const s of e.symbols) {
      const label = s.parent ? `${s.parent}.${s.name}` : s.name;
      const own = words(s.name);
      const cls = s.parent ? words(s.parent) : [];
      const fit = (n: string, w: string) => (n === w ? 3 : n.startsWith(w) || (n.length >= 3 && w.startsWith(n)) ? 2 : n.includes(w) ? 1 : 0);
      let score = 0;
      for (const w of q) {
        // a word in the method's own name counts fully; only in its class's name, half
        const best = Math.max(0, ...own.map((n) => fit(n, w))) || Math.max(0, ...cls.map((n) => fit(n, w))) / 2;
        if (!best) {
          score = 0;
          break;
        }
        score += best;
      }
      if (!score) continue;
      if (own.join("") === whole || [...cls, ...own].join("") === whole) score += 10; // the exact name
      // the query's words side by side, in order: "pod eviction" -> podEvictionTime over evictPodForNode
      const at = own.findIndex((n) => fit(n, q[0]) >= 2);
      if (q.length > 1 && at >= 0 && q.every((w, i) => own[at + i] !== undefined && fit(own[at + i], w) >= 2)) score += 3;
      path ??= words(f);
      score += q.filter((w) => path!.includes(w)).length * 0.5;
      hits.push({ score, label, at: `${f}:${s.line}`, s });
    }
  }
  if (!hits.length) return `No function, class or method matches \`${query}\`.`;
  // best score; then top-level before methods, shorter names, path order
  hits.sort((a, b) => b.score - a.score || +!!a.s.parent - +!!b.s.parent || a.label.length - b.label.length || (a.at < b.at ? -1 : 1));
  const shown = hits.slice(0, limit).map(({ label, at, s }) => `- ${s.kind} \`${label}\` at \`${at}\`${s.exported ? " (exported)" : ""}`);
  const more = hits.length > limit ? [`…and ${hits.length - limit} more; add a word to narrow it.`] : [];
  return [`# Search: ${query} (${hits.length} match${hits.length === 1 ? "" : "es"})`, "", ...shown, ...more].join("\n");
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
