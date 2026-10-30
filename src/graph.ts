import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryPoints, importersOf, resolvedCalls, STORE, update } from "./index.js";
import { loadNotes } from "./notes.js";

/** Re-index, then write a self-contained interactive dependency graph to .codemem/graph.html. */
export function writeGraph(root: string): string {
  const { index } = update(root);
  const importers = importersOf(index);
  const entries = new Set(entryPoints(root, index));
  const data = {
    files: Object.entries(index.files).map(([path, e]) => ({
      path,
      imports: e.imports,
      external: e.external,
      importedBy: importers.get(path) ?? [],
      entry: entries.has(path),
      uses: e.uses,
      symbols: e.symbols.map(({ calls, ...s }) => ({ ...s, calls: resolvedCalls(index, path, calls) })),
    })),
    notes: loadNotes(root),
  };
  const out = join(root, STORE, "graph.html");
  // "<" escaped so file names or notes can't close the <script> tag
  writeFileSync(out, PAGE.replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c")));
  return out;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codebase Graph</title>
<style>
  :root { --bg:#fafaf9; --panel:#fff; --text:#1c1917; --muted:#78716c; --line:#e7e5e4; --edge:#a8a29e; --accent:#2563eb; --entry:#d97706; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --panel:#1c1917; --text:#e7e5e4; --muted:#a8a29e; --line:#292524; --edge:#57534e; --accent:#60a5fa; --entry:#fbbf24; } }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:grid; grid-template-rows:auto 1fr; grid-template-columns:1fr 340px; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif; }
  header { grid-column:1/-1; display:flex; gap:16px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; }
  header .stats { color:var(--muted); font-size:13px; }
  header input { margin-left:auto; padding:6px 10px; width:240px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
  #cy { min-height:0; }
  aside { border-left:1px solid var(--line); background:var(--panel); padding:16px; overflow:auto; }
  aside h2 { font-size:14px; margin:0 0 4px; word-break:break-all; }
  aside h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:16px 0 4px; }
  aside ul { margin:0; padding-left:18px; }
  aside a { color:var(--accent); cursor:pointer; word-break:break-all; }
  .note { border-left:3px solid var(--accent); padding:4px 8px; margin:6px 0; white-space:pre-wrap; }
  .note b { display:block; }
  .muted { color:var(--muted); }
  .legend span { display:inline-block; width:10px; height:10px; border-radius:50%; border:2px solid var(--entry); vertical-align:middle; margin-right:4px; }
  @media (max-width: 720px) { body { grid-template-columns:1fr; grid-template-rows:auto 1fr 40vh; } aside { border-left:0; border-top:1px solid var(--line); } header input { width:100%; } }
</style>
</head>
<body>
<header>
  <h1>Codebase Graph</h1>
  <span class="stats" id="stats"></span>
  <span class="stats legend"><span></span>entry point · size = importers · arrow = imports</span>
  <input id="q" type="search" placeholder="Find file or function… (Enter)" aria-label="Find file or function">
</header>
<div id="cy" role="img" aria-label="Module dependency graph"></div>
<aside id="panel"><p class="muted">Click a file to see its imports, importers and notes. Click a folder box to see its files.</p></aside>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-layout-utilities@1.1.1/cytoscape-layout-utilities.js"></script>
<script>
const DATA = __DATA__;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const within = (f, p) => f === p || f.startsWith(p + "/");
const dirOf = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PALETTE = ["#2563eb","#16a34a","#db2777","#9333ea","#0891b2","#ea580c","#65a30d","#dc2626","#4f46e5","#0d9488"];
const tops = [...new Set(DATA.files.map((f) => f.path.split("/")[0]))];
const colorOf = (p) => PALETTE[tops.indexOf(p.split("/")[0]) % PALETTE.length];

// one compound node per directory, nested like the folder tree
const els = [], dirs = new Set();
const addDir = (d) => {
  if (!d || dirs.has(d)) return;
  dirs.add(d); addDir(dirOf(d));
  els.push({ data: { id: "dir:" + d, name: d.split("/").pop() + "/", parent: dirOf(d) ? "dir:" + dirOf(d) : undefined, dir: d } });
};
let edges = 0;
for (const f of DATA.files) {
  addDir(dirOf(f.path));
  els.push({ data: { id: f.path, name: f.path.split("/").pop(), parent: dirOf(f.path) ? "dir:" + dirOf(f.path) : undefined,
    size: 18 + 8 * Math.sqrt(f.importedBy.length), color: colorOf(f.path), entry: f.entry, file: true } });
  for (const t of f.imports) {
    const names = f.uses[t] || [];
    const label = names.slice(0, 3).join(", ") + (names.length > 3 ? " +" + (names.length - 3) : "");
    els.push({ data: { id: f.path + "->" + t, source: f.path, target: t, label } });
    edges++;
  }
}
document.getElementById("stats").textContent = DATA.files.length + " files · " + edges + " imports · " + DATA.notes.length + " notes";

const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: els,
  wheelSensitivity: 0.3,
  style: [
    { selector: "node[?file]", style: { width: "data(size)", height: "data(size)", "background-color": "data(color)", label: "data(name)",
      "font-size": 10, "text-valign": "bottom", "text-margin-y": 3, color: css("--text") } },
    { selector: "node[?entry]", style: { "border-width": 3, "border-color": css("--entry") } },
    { selector: ":parent", style: { label: "data(name)", "text-valign": "top", "text-halign": "center", "font-size": 11, color: css("--muted"),
      "background-color": css("--text"), "background-opacity": 0.04, "border-width": 1, "border-color": css("--line"), shape: "round-rectangle", padding: 12 } },
    { selector: "edge", style: { width: 1, "line-color": css("--edge"), "target-arrow-color": css("--edge"), "target-arrow-shape": "triangle",
      "arrow-scale": 0.7, "curve-style": "bezier", opacity: 0.6 } },
    { selector: ".faded", style: { opacity: 0.1 } },
    // imported names show only on highlighted edges; on all 400+ edges at once they'd be unreadable
    { selector: "edge.hl", style: { "line-color": css("--accent"), "target-arrow-color": css("--accent"), width: 2, opacity: 1,
      label: "data(label)", "font-size": 9, color: css("--text"), "text-rotation": "autorotate",
      "text-background-color": css("--panel"), "text-background-opacity": 0.85, "text-background-padding": 2 } },
    { selector: "node:selected", style: { "overlay-color": css("--accent"), "overlay-opacity": 0.2 } },
  ],
});

// fcose keeps nested folder boxes compact (built-in cose spread a 173-file repo over 28000px), and packComponents
// places folders that never import each other (frontend vs backend) side by side instead of far apart.
// shortcut: canvas rendering gets sluggish past ~2000 files; switch to a WebGL renderer if repos get that big.
cy.layoutUtilities({ desiredAspectRatio: cy.width() / cy.height(), componentSpacing: 40 });
cy.layout({ name: "fcose", animate: false, quality: "proof", nodeRepulsion: () => 6000, idealEdgeLength: () => 60,
  nestingFactor: 0.4, tilingPaddingVertical: 12, tilingPaddingHorizontal: 12, padding: 30, packComponents: true }).run();

const panel = document.getElementById("panel");
const link = (p) => '<li><a data-go="' + esc(p) + '">' + esc(p) + "</a></li>";
const list = (title, items, fmt = link) => items.length ? "<h3>" + title + " (" + items.length + ")</h3><ul>" + items.map(fmt).join("") + "</ul>" : "";
const named = (p, names) => link(p).replace("</li>", names && names.length ? ' <span class="muted">' + esc(names.join(", ")) + "</span></li>" : "</li>");
const callsHtml = (s, file) => s.calls.length ? ' <span class="muted">→</span> ' + s.calls.map((c) => c.file === file ? esc(c.name)
  : '<a data-go="' + esc(c.file) + '" title="' + esc(c.file) + '">' + esc(c.name) + "</a>").join(", ") : "";
function symbolsHtml(f) {
  const top = f.symbols.filter((s) => !s.parent);
  if (!top.length) return "";
  const item = (s) => "<li><code>" + esc(s.kind === "class" ? "class " + s.name : s.name) + '</code> <span class="muted">:' + s.line + "</span>" +
    callsHtml(s, f.path) + (s.kind === "class" ? subList(f.symbols.filter((m) => m.parent === s.name)) : "") + "</li>";
  const subList = (ms) => ms.length ? "<ul>" + ms.map(item).join("") + "</ul>" : "";
  return "<h3>Defines (" + top.length + ")</h3><ul>" + top.map(item).join("") + "</ul>";
}
const notesHtml = (notes) => notes.length ? "<h3>Notes</h3>" + notes.map((n) =>
  '<div class="note"><b>[' + esc(n.kind) + "] " + esc(n.title) + "</b>" + esc(n.body) + '<div class="muted">' + esc(n.date) + "</div></div>").join("") : "";

function focus(id) {
  const n = cy.getElementById(id);
  if (!n.length) return;
  cy.elements().removeClass("faded hl").unselect();
  if (n.data("file")) {
    const hood = n.closedNeighborhood();
    cy.elements().not(hood).not(hood.ancestors()).addClass("faded");
    n.connectedEdges().addClass("hl");
    const f = DATA.files.find((x) => x.path === id);
    panel.innerHTML = "<h2>" + esc(id) + "</h2>" + (f.entry ? '<span class="muted">entry point</span>' : "") +
      notesHtml(DATA.notes.filter((x) => x.paths.some((p) => within(id, p)))) +
      symbolsHtml(f) +
      list("Imports", f.imports, (p) => named(p, f.uses[p])) +
      list("Imported by", f.importedBy, (p) => named(p, DATA.files.find((x) => x.path === p).uses[id])) +
      list("Packages", f.external, (p) => "<li>" + esc(p) + "</li>");
  } else {
    const d = n.data("dir");
    cy.elements().not(n.union(n.descendants())).not(n.ancestors()).addClass("faded");
    panel.innerHTML = "<h2>" + esc(d) + "/</h2>" +
      notesHtml(DATA.notes.filter((x) => x.paths.some((p) => within(d, p) || within(p, d)))) +
      list("Files", DATA.files.filter((x) => within(x.path, d)).map((x) => x.path));
  }
  n.select();
  cy.animate({ center: { eles: n }, duration: 250 });
}

cy.on("tap", "node", (e) => focus(e.target.id()));
cy.on("tap", (e) => { if (e.target === cy) { cy.elements().removeClass("faded hl").unselect(); } });
panel.addEventListener("click", (e) => { const go = e.target.closest("[data-go]"); if (go) focus(go.dataset.go); });
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  // file path first, then the file defining a function/class with that name
  const hit = DATA.files.find((f) => f.path.toLowerCase().includes(q)) ||
    DATA.files.find((f) => f.symbols.some((s) => s.name.toLowerCase() === q)) ||
    DATA.files.find((f) => f.symbols.some((s) => s.name.toLowerCase().includes(q)));
  if (q && hit) focus(hit.path);
});
</script>
</body>
</html>
`;
