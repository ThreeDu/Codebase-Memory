import { importersOf, loadIndex } from "./index.js";
import { loadNotes, normalizePath } from "./notes.js";

const within = (file: string, path: string) => file === path || file.startsWith(path + "/");

/**
 * Selective context for one task: target is a file, a folder, or a keyword.
 * Returns the matching notes plus the matched files with their 1-hop neighbours, cut to `budget` chars.
 */
export function context(root: string, target: string, budget = 8000): string {
  const index = loadIndex(root);
  const files = Object.keys(index.files).sort();
  if (!files.length) return "No index yet. Run `codemem index` (or the `reindex` tool) first.";

  const t = normalizePath(target);
  const kw = t.toLowerCase();
  let matched = files.filter((f) => within(f, t));
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
      out.push(`### [${n.kind}] ${n.title} (${n.date}${n.paths.length ? `; ${n.paths.join(", ")}` : ""})`, n.body, "");
  }
  out.push(`## Files (${matched.length})`);
  for (const f of matched) {
    const e = index.files[f];
    out.push(`- \`${f}\``);
    if (e.imports.length) out.push(`  - imports: ${e.imports.join(", ")}`);
    if (e.external.length) out.push(`  - packages: ${e.external.join(", ")}`);
    const by = importers.get(f);
    if (by?.length) out.push(`  - imported by: ${by.join(", ")}`);
  }
  if (!matched.length) out.push("_No files matched._");

  const text = out.join("\n");
  return text.length <= budget ? text : `${text.slice(0, budget)}\n…(truncated ${text.length - budget} chars; narrow the target)`;
}
