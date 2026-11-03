import { join } from "node:path";
import { writeAtomic } from "./files.js";
import { entryPoints, importersOf, isTest, resolvedCalls, STORE, update } from "./index.js";
import { loadNotes, staleMark } from "./notes.js";

const LANGUAGE: [RegExp, string][] = [
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/, "JavaScript"],
  [/\.py$/, "Python"],
  [/\.go$/, "Go"],
  [/\.java$/, "Java"],
  [/\.rs$/, "Rust"],
  [/\.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/, "C/C++"],
  [/\.cs$/, "C#"],
];

/** Re-index, then write a self-contained interactive dependency graph to .codemem/graph.html. */
export function writeGraph(root: string): string {
  const { index } = update(root);
  const importers = importersOf(index);
  const entries = new Set(entryPoints(root, index));
  const data = {
    files: Object.entries(index.files).map(([path, e]) => ({
      path,
      lang: LANGUAGE.find(([re]) => re.test(path))?.[1] ?? "Other",
      test: isTest(path),
      imports: e.imports,
      external: e.external,
      importedBy: importers.get(path) ?? [],
      entry: entries.has(path),
      uses: e.uses,
      symbols: e.symbols.map(({ calls, ...s }) => ({ ...s, calls: resolvedCalls(index, path, calls) })),
    })),
    notes: loadNotes(root).map((n) => ({ ...n, stale: staleMark(root, n).trim() })),
  };
  const out = join(root, STORE, "graph.html");
  // "<" escaped so file names or notes can't close the <script> tag
  writeAtomic(out, PAGE.replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c")));
  return out;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codebase Graph</title>
<style>
  /* dark only */
  :root { color-scheme:dark; --bg:#0c0a09; --panel:#1c1917; --text:#e7e5e4; --muted:#a8a29e; --line:#292524; --edge:#57534e; --accent:#60a5fa; --in:#4ade80; --entry:#fbbf24; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:grid; grid-template-rows:auto 1fr; grid-template-columns:1fr 340px; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif; }
  header { grid-column:1/-1; display:flex; gap:8px 16px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; }
  header .stats { color:var(--muted); font-size:13px; }
  header input[type=search] { margin-left:auto; padding:6px 10px; width:240px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
  .tools { display:flex; gap:8px; align-items:center; }
  .tools button, .tools label { font:inherit; font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; }
  .tools button:focus-visible, .tools input:focus-visible, header input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .legend { flex-basis:100%; display:flex; gap:4px 14px; flex-wrap:wrap; font-size:12px; color:var(--muted); }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:-1px; }
  .legend i.ring { background:none; border:2px solid var(--entry); }
  .legend i.test { background:none; border:1.5px dashed var(--muted); }
  .legend i.line { width:16px; height:0; border-radius:0; border-top:2px solid; vertical-align:3px; }
  /* grid items default to min-width:auto: without 0 the canvas keeps its first width and pushes the panel off-screen */
  #cy { min-width:0; min-height:0; }
  #tip { position:fixed; z-index:5; display:none; pointer-events:none; max-width:380px; padding:6px 9px; font-size:12px; line-height:1.4;
    background:var(--panel); border:1px solid var(--line); border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,.18); word-break:break-all; }
  #tip b { display:block; }
  aside { border-left:1px solid var(--line); background:var(--panel); padding:16px; overflow:auto; }
  aside h2 { font-size:14px; margin:0 0 4px; word-break:break-all; }
  aside h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:16px 0 4px; }
  aside ul { margin:0; padding-left:18px; }
  aside a { color:var(--accent); cursor:pointer; word-break:break-all; }
  .note { border-left:3px solid var(--accent); padding:4px 8px; margin:6px 0; white-space:pre-wrap; }
  .note b { display:block; }
  .note.stale { border-left-color:var(--entry); }
  .warn { color:var(--entry); }
  .muted { color:var(--muted); }
  @media (max-width: 720px) { body { grid-template-columns:1fr; grid-template-rows:auto 1fr 40vh; } aside { border-left:0; border-top:1px solid var(--line); } header input[type=search] { width:100%; } }
</style>
</head>
<body>
<header>
  <h1>Codebase Graph</h1>
  <span class="stats" id="stats"></span>
  <div class="tools">
    <button id="fit" type="button" title="Zoom to show everything">Fit</button>
    <label><input id="hideTests" type="checkbox"> Hide tests</label>
  </div>
  <input id="q" type="search" placeholder="Find file or function… (Enter)" aria-label="Find file or function">
  <div class="legend" id="legend"></div>
</header>
<div id="cy" role="img" aria-label="Module dependency graph"></div>
<aside id="panel"><p class="muted">Hover a dot for a summary; click a file for its imports, importers, functions and notes; click a folder box for its files. Esc clears the selection.</p></aside>
<div id="tip" role="tooltip"></div>
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
// color = language: what a reader tells apart at a glance in a mixed repo (folders already have their boxes)
const LANG_COLOR = { TypeScript:"#60a5fa", JavaScript:"#facc15", Python:"#4ade80", Go:"#22d3ee", Java:"#fb923c", Rust:"#c084fc", "C/C++":"#f472b6", "C#":"#818cf8", Other:"#a8a29e" };
const byPath = new Map(DATA.files.map((f) => [f.path, f]));

// One box per folder, nested like the folder tree, except that a chain of folders holding only one folder each
// (test/fixtures/javasample/src/main/java/com/shop) becomes a single box: 8 nested boxes shrank everything to unreadable
const allDirs = new Set(), filesIn = new Map(), subdirsOf = new Map();
for (const f of DATA.files) {
  const d = dirOf(f.path);
  filesIn.set(d, (filesIn.get(d) || 0) + 1);
  for (let x = d; x && !allDirs.has(x); x = dirOf(x)) {
    allDirs.add(x);
    subdirsOf.set(dirOf(x), (subdirsOf.get(dirOf(x)) || 0) + 1);
  }
}
const isBox = (d) => filesIn.has(d) || (subdirsOf.get(d) || 0) >= 2;
const boxAbove = (d) => { for (let x = dirOf(d); x; x = dirOf(x)) if (isBox(x)) return x; return ""; };
const els = [];
for (const d of allDirs) {
  if (!isBox(d)) continue;
  const up = boxAbove(d);
  els.push({ data: { id: "dir:" + d, name: (up ? d.slice(up.length + 1) : d) + "/", parent: up ? "dir:" + up : undefined, dir: d, top: !up } });
}
let edges = 0;
for (const f of DATA.files) {
  els.push({ data: { id: f.path, name: f.path.split("/").pop(), parent: dirOf(f.path) ? "dir:" + dirOf(f.path) : undefined,
    size: 16 + 7 * Math.sqrt(f.importedBy.length), color: LANG_COLOR[f.lang], entry: f.entry, test: f.test, file: true } });
  for (const t of f.imports) {
    const names = f.uses[t] || [];
    const label = names.slice(0, 3).join(", ") + (names.length > 3 ? " +" + (names.length - 3) : "");
    els.push({ data: { id: f.path + "->" + t, source: f.path, target: t, label } });
    edges++;
  }
}

// legend: only the languages this repo has, most files first
const langs = {};
for (const f of DATA.files) langs[f.lang] = (langs[f.lang] || 0) + 1;
document.getElementById("legend").innerHTML =
  Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => '<span><i style="background:' + LANG_COLOR[l] + '"></i>' + esc(l) + " " + n + "</span>").join("") +
  '<span><i class="ring"></i>entry point</span><span><i class="test"></i>test</span>' +
  '<span><i class="line" style="border-color:var(--accent)"></i>imports</span><span><i class="line" style="border-color:var(--in)"></i>imported by</span>' +
  "<span>bigger dot = imported by more files</span>";
const staleNotes = DATA.notes.filter((n) => n.stale);
document.getElementById("stats").textContent = DATA.files.length + " files · " + edges + " imports · " + DATA.notes.length + " notes" +
  (staleNotes.length ? " · " + staleNotes.length + " ⚠ out of date" : "");

const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: els,
  wheelSensitivity: 0.3,
  style: [
    // labels are drawn only once they're big enough to read (min-zoomed-font-size), instead of as a grey smear
    { selector: "node[?file]", style: { width: "data(size)", height: "data(size)", "background-color": "data(color)", label: "data(name)",
      "font-size": 11, "min-zoomed-font-size": 8, "text-valign": "bottom", "text-margin-y": 3, color: css("--text"),
      "text-outline-color": css("--bg"), "text-outline-width": 2 } },
    { selector: "node[?test]", style: { "background-opacity": 0.35, "border-width": 1.5, "border-style": "dashed", "border-color": "data(color)" } },
    { selector: "node[?entry]", style: { "border-width": 3, "border-style": "solid", "border-color": css("--entry") } },
    { selector: ":parent", style: { label: "data(name)", "text-valign": "top", "text-halign": "center", "font-size": 13, "font-weight": 600,
      "min-zoomed-font-size": 6, color: css("--muted"), "background-color": css("--text"), "background-opacity": 0.035,
      "border-width": 1, "border-color": css("--line"), shape: "round-rectangle", padding: 14 } },
    { selector: "edge", style: { width: 1, "line-color": css("--edge"), "target-arrow-color": css("--edge"), "target-arrow-shape": "triangle",
      "arrow-scale": 0.7, "curve-style": "bezier", opacity: 0.5 } },
    { selector: ".faded", style: { opacity: 0.08 } },
    { selector: ".hidden", style: { display: "none" } },
    // a selected file's edges: what it imports in blue, what imports it in green, each labelled with the names taken;
    // on all edges at once the names would be unreadable
    { selector: "edge.out, edge.in", style: { width: 2.5, opacity: 1, label: "data(label)", "font-size": 10, color: css("--text"),
      "text-rotation": "autorotate", "text-background-color": css("--panel"), "text-background-opacity": 0.9, "text-background-padding": 2 } },
    { selector: "edge.out", style: { "line-color": css("--accent"), "target-arrow-color": css("--accent") } },
    { selector: "edge.in", style: { "line-color": css("--in"), "target-arrow-color": css("--in") } },
    { selector: "node:selected", style: { "overlay-color": css("--accent"), "overlay-opacity": 0.25, "overlay-padding": 4 } },
  ],
});

// fcose keeps nested folder boxes compact (built-in cose spread a 173-file repo over 28000px), and packComponents
// places folders that never import each other (frontend vs backend) side by side instead of far apart.
// shortcut: canvas rendering gets sluggish past ~2000 files; switch to a WebGL renderer if repos get that big.
cy.layoutUtilities({ desiredAspectRatio: cy.width() / cy.height(), componentSpacing: 40 });
// fcose doesn't promise dots never touch: in a 173-file repo the two most-imported (biggest) files, Order.js and
// Product.js, ended up on top of each other. So afterwards, dots in the same folder box that are closer than their radii
// plus room for a name get pushed apart along the line between them, a few rounds until none overlap.
function separate(eles) {
  const byBox = new Map();
  eles.nodes("[?file]").not(".hidden").forEach((n) => {
    const box = n.data("parent") || "";
    byBox.set(box, [...(byBox.get(box) || []), n]);
  });
  cy.batch(() => {
    for (const ns of byBox.values())
      for (let round = 0, moved = true; moved && round < 30; round++) {
        moved = false;
        for (let i = 0; i < ns.length; i++)
          for (let j = i + 1; j < ns.length; j++) {
            const a = ns[i].position(), b = ns[j].position();
            const min = (ns[i].width() + ns[j].width()) / 2 + 16;
            let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
            if (d >= min) continue;
            if (d < 0.01) [dx, dy, d] = [1, 0, 1]; // exactly on top: pick a direction
            const push = (min - d) / 2;
            ns[i].position({ x: a.x - (dx / d) * push, y: a.y - (dy / d) * push });
            ns[j].position({ x: b.x + (dx / d) * push, y: b.y + (dy / d) * push });
            moved = true;
          }
      }
  });
}
const layout = (eles) => {
  eles.layout({ name: "fcose", animate: false, quality: "proof", nodeRepulsion: () => 6000, idealEdgeLength: () => 60,
    nestingFactor: 0.4, tilingPaddingVertical: 12, tilingPaddingHorizontal: 12, padding: 30, packComponents: true,
    nodeDimensionsIncludeLabels: true }).run();
  separate(eles);
};
layout(cy.elements());

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
const notesHtml = (notes, title = "Notes") => notes.length ? "<h3>" + title + "</h3>" + notes.map((n) =>
  '<div class="note' + (n.stale ? " stale" : "") + '"><b>#' + n.id + " [" + esc(n.kind) + "] " + esc(n.title) + "</b>" +
  (n.stale ? '<div class="warn">' + esc(n.stale) + "</div>" : "") + esc(n.body) + '<div class="muted">' + esc(n.date) + "</div></div>").join("") : "";
// a note about a deleted file has no node to click, so list out-of-date notes up front
if (staleNotes.length) panel.innerHTML += notesHtml(staleNotes, "Out-of-date notes (" + staleNotes.length + ")");

const clear = () => cy.elements().removeClass("faded out in").unselect();

// move: jumping here from search or a side-panel link (the camera follows); a click on the graph leaves the camera alone
function focus(id, move = false) {
  const n = cy.getElementById(id);
  if (!n.length) return;
  if (n.hasClass("hidden")) setHideTests(false); // a search hit among hidden tests: show them again
  clear();
  if (n.data("file")) {
    const hood = n.closedNeighborhood();
    cy.elements().not(hood).not(hood.ancestors()).addClass("faded");
    n.outgoers("edge").addClass("out");
    n.incomers("edge").addClass("in");
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
  // never zoom on the user's behalf (it was disorienting); only bring a jumped-to node into view, at the current zoom
  const p = n.renderedPosition();
  if (move && (p.x < 0 || p.y < 0 || p.x > cy.width() || p.y > cy.height())) cy.animate({ center: { eles: n }, duration: 200 });
}

cy.on("tap", "node", (e) => focus(e.target.id()));
cy.on("tap", (e) => { if (e.target === cy) clear(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") clear(); });

// hover: a one-line summary without clicking
const tip = document.getElementById("tip");
cy.on("mouseover", "node", (e) => {
  const n = e.target, f = byPath.get(n.id());
  tip.innerHTML = f
    ? "<b>" + esc(f.path) + "</b>" + esc(f.lang) + (f.test ? " · test" : "") + (f.entry ? " · entry point" : "") +
      "<br>imported by " + f.importedBy.length + " · imports " + f.imports.length + " · defines " + f.symbols.filter((s) => !s.parent).length
    : "<b>" + esc(n.data("dir")) + "/</b>" + n.descendants("[?file]").length + " files";
  tip.style.display = "block";
});
cy.on("mousemove", "node", (e) => {
  const r = cy.container().getBoundingClientRect(), p = e.renderedPosition;
  tip.style.left = Math.min(r.left + p.x + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.min(r.top + p.y + 14, innerHeight - tip.offsetHeight - 8) + "px";
});
cy.on("mouseout", "node", () => { tip.style.display = "none"; });

// The outermost folders' names keep ~13px on screen at any zoom, so the repo's main areas are named even when all of it
// is in view. Resized after layout: bigger labels during layout made the boxes, and the whole picture, grow instead.
let pending = false;
const sizeTopLabels = () => {
  pending = false;
  cy.style().selector(":parent[?top]").style({ "font-size": Math.max(13, 13 / cy.zoom()), "min-zoomed-font-size": 0 }).update();
};
cy.on("zoom", () => { if (!pending) { pending = true; requestAnimationFrame(sizeTopLabels); } });

const fit = () => cy.fit(cy.elements().not(".hidden"), 30);
document.getElementById("fit").addEventListener("click", fit);
fit(); // fcose's own fit runs before packComponents moves the groups: refitting draws this repo 70% bigger
sizeTopLabels();

// tests are often half the files (fixtures included): hiding them leaves the app's own structure, laid out again
const hideBox = document.getElementById("hideTests");
function setHideTests(on) {
  hideBox.checked = on;
  cy.batch(() => {
    cy.nodes("[?test]").toggleClass("hidden", on);
    // a folder left with no visible file would stay as an empty box
    cy.nodes(":parent").forEach((d) => d.toggleClass("hidden", on && d.descendants("[?file]").every((f) => f.hasClass("hidden"))));
  });
  layout(cy.elements().not(".hidden"));
  fit();
}
hideBox.addEventListener("change", () => setHideTests(hideBox.checked));
panel.addEventListener("click", (e) => { const go = e.target.closest("[data-go]"); if (go) focus(go.dataset.go, true); });
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  // file path first, then the file defining a function/class with that name
  const hit = DATA.files.find((f) => f.path.toLowerCase().includes(q)) ||
    DATA.files.find((f) => f.symbols.some((s) => s.name.toLowerCase() === q)) ||
    DATA.files.find((f) => f.symbols.some((s) => s.name.toLowerCase().includes(q)));
  if (q && hit) focus(hit.path, true);
});
</script>
</body>
</html>
`;
