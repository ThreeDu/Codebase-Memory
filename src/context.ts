import { readFileSync } from "node:fs";
import { join } from "node:path";
import { definedIn, importersOf, isTest, resolvedCalls, update, type FileEntry, type Index } from "./index.js";
import { loadNotes, normalizePath, staleMark } from "./notes.js";
import type { Sym } from "./parse.js";

const within = (file: string, path: string) => file === path || file.startsWith(path + "/");
const withNames = (file: string, names?: string[]) => (names?.length ? `${file} (${names.join(", ")})` : file);
const labelOf = (s: Sym) => (s.parent ? `${s.parent}.${s.name}` : s.name);

/** Files that use top-level symbol `s` of file `f`, with the functions in them that call it. */
function usersOf(index: Index, f: string, s: Sym): { file: string; in: string[] }[] {
  const out: { file: string; in: string[] }[] = [];
  for (const [g, ge] of Object.entries(index.files)) {
    if (definedIn(index, g, s.name) !== f) continue;
    const callers = ge.symbols.filter((x) => x.calls?.includes(s.name) && x !== s).map(labelOf);
    const imported = g !== f && Object.values(ge.uses).some((n) => n.includes(s.name) || n.includes("*"));
    if (callers.length || imported) out.push({ file: g, in: callers });
  }
  return out;
}

/** The definition a `// WHY:` comment is about: one starting just below it (the usual place), else the innermost one
 * containing it; none for a comment at file level. */
function ownerOf(e: FileEntry, line: number): Sym | undefined {
  const below = e.symbols.find((s) => s.line > line && s.line - line <= 3);
  return below ?? e.symbols.filter((s) => s.line <= line && line <= (s.end ?? s.line)).sort((a, b) => b.line - a.line)[0];
}

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
    out.push(`- ${s.kind} \`${s.parent ? `${s.parent}.` : ""}${s.name}\` defined at \`${f}:${s.line}\``);
    if (s.kind === "class") {
      const methods = e.symbols.filter((m) => m.parent === s.name).map((m) => m.name);
      if (methods.length) out.push(`  - methods: ${methods.join(", ")}`);
    }
    if (s.parent) continue; // shortcut: method calls through instances (obj.method()) aren't tracked
    for (const u of usersOf(index, f, s)) out.push(`  - used by \`${u.file}\`${u.in.length ? ` in: ${u.in.join(", ")}` : ""}`);
  }
  return out;
}

// shortcut: every query re-hashes all files so answers are never stale; add a file watcher if that gets slow on big repos.
const fresh = (root: string) => update(root).index;

export function findSymbol(root: string, name: string): string {
  const lines = symbolLines(fresh(root), name.trim());
  return lines.length ? [`# Symbol: ${name}`, "", ...lines].join("\n") : `No function or class named \`${name}\`.`;
}

/** The source of a function/class/method, so an agent can read just that instead of the whole file, followed by who
 * uses it (what an edit could break, and whether any test covers it) and the WHY/NOTE comments about it. */
export function readSymbol(root: string, name: string): string {
  const index = fresh(root);
  const found = matches(index, name.trim());
  if (!found.length) return `No function or class named \`${name}\`.`;
  return found
    .map(([f, s]) => {
      const lines = readFileSync(join(root, f), "utf8").split(/\r?\n/);
      const end = s.end ?? s.line;
      const out = [`## \`${f}:${s.line}-${end}\``, "", "```", ...lines.slice(s.line - 1, end), "```", ""];
      if (s.parent) out.push(`Callers of methods aren't tracked (\`obj.${s.name}()\`); search for \`.${s.name}(\` to find them.`);
      else {
        const users = usersOf(index, f, s);
        const shown = users.slice(0, 15).map((u) => `\`${u.file}\`${u.in.length ? ` (${u.in.join(", ")})` : ""}`);
        if (!users.length) out.push("Used by: nothing in the indexed code (an entry point, called dynamically, or unused).");
        else out.push(`Used by: ${shown.join("; ")}${users.length > 15 ? `; …and ${users.length - 15} more` : ""}`);
        if (users.length && !users.some((u) => isTest(u.file))) out.push("⚠ No test file uses it directly.");
      }
      const whys = (index.files[f].whys ?? []).filter((w) => ownerOf(index.files[f], w.line) === s);
      if (whys.length) out.push("", "Comments about it:", ...whys.map((w) => `- ${w.tag} (line ${w.line}): ${w.text}`));
      return out.join("\n");
    })
    .join("\n\n");
}

/** Files that depend on the changed ones, directly or through others (up to `depth` import hops), and the tests among
 * them. A test ends the walk: whatever imports a test isn't affected by the change through it. */
export function affected(root: string, changed: string[], depth = 5) {
  const index = fresh(root);
  const importers = importersOf(index);
  const tests = new Set<string>();
  const hops = new Map<string, number>(); // dependent -> fewest import hops from a changed file
  const unknown: string[] = [];
  const start = [...new Set(changed.map(normalizePath).filter(Boolean))];
  for (const c of start) {
    if (!index.files[c]) unknown.push(c);
    else if (isTest(c)) tests.add(c);
    else {
      const queue: [string, number][] = [[c, 0]];
      const seen = new Set([c]);
      while (queue.length) {
        const [f, d] = queue.shift()!;
        if (d >= depth) continue;
        for (const g of importers.get(f) ?? []) {
          if (seen.has(g)) continue;
          seen.add(g);
          if (isTest(g)) tests.add(g);
          else {
            hops.set(g, Math.min(hops.get(g) ?? Infinity, d + 1));
            queue.push([g, d + 1]);
          }
        }
      }
    }
  }
  for (const c of start) hops.delete(c);
  const files = [...hops].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return { tests: [...tests].sort(), files, unknown };
}

export function formatAffected(root: string, changed: string[], depth = 5): string {
  const { tests, files, unknown } = affected(root, changed, depth);
  const cap = <T>(xs: T[], show: (x: T) => string) =>
    [...xs.slice(0, 100).map(show), ...(xs.length > 100 ? [`- …and ${xs.length - 100} more`] : [])];
  const out = [`# Affected by: ${changed.join(", ")}`, ""];
  out.push(`## Tests to run (${tests.length})`, ...(tests.length ? cap(tests, (t) => `- \`${t}\``) : [`No test depends on these files within ${depth} import hops.`]), "");
  out.push(`## Files that depend on them (${files.length})`, ...cap(files, ([f, d]) => `- \`${f}\` (${d} hop${d > 1 ? "s" : ""})`));
  if (unknown.length) out.push("", `Not indexed (not a source file codemem reads, or not a path from the project root): ${unknown.join(", ")}`);
  return out.join("\n");
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
  const q = [...new Set(words(query))];
  if (!q.length) return "Give a name or a few words to search for.";
  const whole = q.join("");
  const fit = (n: string, w: string) => (n === w ? 3 : n.startsWith(w) || (n.length >= 3 && w.startsWith(n)) ? 2 : n.includes(w) ? 1 : 0);
  // every symbol with any query word, and how many symbols have each word
  const cands: { f: string; s: Sym; own: string[]; best: number[]; matched: number }[] = [];
  const df = q.map(() => 0);
  let total = 0;
  for (const [f, e] of Object.entries(index.files))
    for (const s of e.symbols) {
      total++;
      const own = words(s.name);
      const cls = s.parent ? words(s.parent) : [];
      // a word in the method's own name counts fully; only in its class's name, half
      const best = q.map((w) => Math.max(0, ...own.map((n) => fit(n, w))) || Math.max(0, ...cls.map((n) => fit(n, w))) / 2);
      const matched = best.filter((b, i) => b && ++df[i]).length;
      if (matched) cands.push({ f, s, own, best, matched });
    }
  // a word few names contain says more than one most contain ("webhook" vs "get"), as graphify weighs its terms
  const idf = df.map((d) => Math.log(1 + total / (1 + d)));
  const mean = idf.reduce((a, b) => a + b, 0) / idf.length;
  // no name has every word: fall back to names with most of them, rather than nothing
  const full = cands.filter((c) => c.matched === q.length);
  const partial = !full.length && q.length > 1;
  const pool = partial ? cands.filter((c) => c.matched >= Math.ceil(q.length / 2)) : full;
  if (!pool.length) return `No function, class or method matches \`${query}\`.`;

  const aboutTests = /test|spec/i.test(query);
  const importers = importersOf(index);
  const hits = pool.map(({ f, s, own, best }) => {
    let score = best.reduce((sum, b, i) => sum + (b * idf[i]) / mean, 0);
    if (own.join("") === whole || words(labelOf(s)).join("") === whole) score += 10; // the exact name
    // the query's words side by side, in order: "pod eviction" -> podEvictionTime over evictPodForNode
    const at = own.findIndex((n) => fit(n, q[0]) >= 2);
    if (q.length > 1 && at >= 0 && q.every((w, i) => own[at + i] !== undefined && fit(own[at + i], w) >= 2)) score += 3;
    const path = words(f);
    score += q.filter((w) => path.includes(w)).length * 0.5;
    // the code under test before the tests, unless tests are what's asked for. A ranking penalty (codegraph's x0.3)
    // wasn't enough: on codegraph, test helpers named exactly `explore` still outranked getExploreBudget
    const test = !aboutTests && isTest(f);
    return { score, test, label: labelOf(s), at: `${f}:${s.line}`, s, used: importers.get(f)?.length ?? 0 };
  });
  // code before tests; then best score, the more depended-on file, top-level before methods, shorter names, path order
  hits.sort(
    (a, b) =>
      +a.test - +b.test ||
      b.score - a.score ||
      b.used - a.used ||
      +!!a.s.parent - +!!b.s.parent ||
      a.label.length - b.label.length ||
      (a.at < b.at ? -1 : 1),
  );
  const shown = hits.slice(0, limit).map(({ label, at, s }) => `- ${s.kind} \`${label}\` at \`${at}\`${s.exported ? " (exported)" : ""}`);
  const more = hits.length > limit ? [`…and ${hits.length - limit} more; add a word to narrow it.`] : [];
  const head = `# Search: ${query} (${hits.length} match${hits.length === 1 ? "" : "es"}${partial ? ", none has every word: closest first" : ""})`;
  return [head, "", ...shown, ...more].join("\n");
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
    out.push(`- \`${f}\`${e.oversize ? " (over 5 MB, not read)" : ""}`);
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
    // reasons written in the code itself, next to the manual notes above
    for (const w of e.whys ?? []) {
      const owner = ownerOf(e, w.line);
      out.push(`  - ${w.tag} :${w.line}${owner ? ` (${labelOf(owner)})` : ""}: ${w.text}`);
    }
  }
  if (!matched.length && !symbols.length) out.push("_No files matched._");

  const text = out.join("\n");
  return text.length <= budget ? text : `${text.slice(0, budget)}\n…(truncated ${text.length - budget} chars; narrow the target)`;
}
