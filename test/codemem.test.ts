import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { context, findSymbol, readSymbol } from "../src/context.js";
import { writeGraph } from "../src/graph.js";
import { definedIn, entryPoints, isSource, renderMap, resolvedCalls, update } from "../src/index.js";
import { addNote, loadNotes, removeNote, updateNote, type Note } from "../src/notes.js";

// copy fixtures outside this git repo so the plain directory walk is used and nothing is written into the repo
const copyFixture = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  cpSync(join(import.meta.dirname, "../../test/fixtures", name), dir, { recursive: true });
  return dir;
};
const root = copyFixture("sample");

test("builds the Python import graph", () => {
  const py = copyFixture("pysample");
  const { index } = update(py);
  const main = index.files["app/main.py"];
  // ".", ".models", "app.models" (multi-line parens), ".util"; "app.models.User" is a name, not a package
  assert.deepEqual(main.imports, ["app/__init__.py", "app/models.py", "app/util.py"]);
  assert.deepEqual(main.external, ["json", "os", "requests"]);
  assert.deepEqual(index.files["run.py"].imports, ["app/main.py"]);
  // service folder as its own source root: found from the importing file's folder, then its parents
  assert.deepEqual(index.files["svc/app.py"].imports, ["svc/config.py", "svc/models/churn.py"]);
  assert.deepEqual(index.files["svc/models/churn.py"].imports, ["svc/config.py"]);
  assert.deepEqual(index.files["svc/app.py"].external, []);
  // test_main.py imports nothing anyone else does, but is a test, so not an entry point
  assert.deepEqual(entryPoints(py, index), ["run.py", "svc/app.py"]);

  // symbols: module CONSTANTS, classes, methods (a nested def is not a method), and what each body uses
  assert.deepEqual(index.files["svc/config.py"].symbols.map((s) => s.name), ["PORT", "DEBUG"]);
  const churn = index.files["svc/models/churn.py"].symbols;
  assert.deepEqual(churn.map((s) => [s.kind, s.name, s.parent]), [["class", "Model", undefined], ["method", "train", "Model"], ["method", "predict", "Model"]]);
  assert.deepEqual(churn[1].calls, ["DEBUG", "PORT"]); // config.DEBUG via `import config`, PORT via from-import
  assert.deepEqual(index.files["svc/app.py"].uses, { "svc/config.py": ["PORT"], "svc/models/churn.py": ["Model"] });
  assert.deepEqual(index.files["svc/app.py"].symbols[0].calls, ["Model"]);
  assert.equal(definedIn(index, "svc/app.py", "Model"), "svc/models/churn.py");
  assert.match(findSymbol(py, "Model.train"), /method `Model.train` defined at `svc\/models\/churn.py:6`/);
  // a method's block ends before the blank line; the class runs to the end of its last method (nested def included)
  assert.deepEqual(churn.map((s) => [s.line, s.end]), [[5, 12], [6, 7], [9, 12]]);
  assert.match(readSymbol(py, "Model.train"), /`svc\/models\/churn.py:6-7`\n\n```\n    def train\(self\):\n        return PORT \+ config.DEBUG\n```/);
});

test("builds the import graph", () => {
  const { index, parsed } = update(root);
  assert.equal(parsed, 5);
  assert.deepEqual(index.files["src/main.ts"].imports, ["src/lib/index.ts"]); // "./lib/index.js" -> .ts
  assert.deepEqual(index.files["src/main.ts"].external, ["chalk"]);
  assert.deepEqual(index.files["src/lib/index.ts"].imports, ["src/lib/greet.ts"]); // extensionless
  assert.deepEqual(index.files["src/lib/greet.ts"].external, ["node:path"]);
});

test("reads TS symbols and what they use across files", () => {
  const { index } = update(root);
  const main = index.files["src/main.ts"];
  assert.deepEqual(main.symbols.map((s) => [s.kind, s.name, s.parent ?? null, s.exported ?? false]), [
    ["function", "run", null, true],
    ["class", "App", null, false],
    ["method", "start", "App", false],
  ]);
  assert.deepEqual(main.uses, { "src/lib/index.ts": ["greet"] });
  assert.deepEqual(index.files["src/lib/index.ts"].uses, { "src/lib/greet.ts": ["*"] }); // export *
  // greet is imported from the barrel but defined in greet.ts; chalk is an external package, so it's dropped
  assert.deepEqual(resolvedCalls(index, "src/main.ts", main.symbols[0].calls), [{ name: "greet", file: "src/lib/greet.ts" }]);
  assert.deepEqual(main.symbols[2].calls, ["run"]); // same-file call from a method
});

test("detects entry points", () => {
  const { index } = update(root);
  // main via package.json (dist/main.js -> src/main.ts), orphan via no importers; the test file is excluded
  assert.deepEqual(entryPoints(root, index), ["src/main.ts", "src/orphan.ts"]);
  assert.match(readFileSync(join(root, ".codemem/map.md"), "utf8"), /## Entry points\n- `src\/main.ts`/);
});

test("re-parses only changed files", () => {
  assert.equal(update(root).parsed, 0);
  writeFileSync(join(root, "src/lib/greet.ts"), `export const greet = (n: string) => n;\n`);
  const { index, parsed } = update(root);
  assert.equal(parsed, 1);
  assert.deepEqual(index.files["src/lib/greet.ts"].external, []);
  rmSync(join(root, "src/orphan.ts"));
  assert.equal(update(root).index.files["src/orphan.ts"], undefined);
});

test("returns selective context with notes", () => {
  addNote(root, { kind: "decision", title: "Barrel exports", body: "lib/ exposes everything via index.ts", paths: ["src/lib"] });
  addNote(root, { kind: "fix", title: "Unrelated", paths: ["docs"] });
  const out = context(root, "src/lib");
  assert.match(out, /Barrel exports/);
  assert.doesNotMatch(out, /Unrelated/);
  assert.match(out, /`src\/lib\/greet.ts`/);
  assert.match(out, /imported by: src\/main.ts/); // 1-hop importer outside the folder
  assert.match(context(root, "greet"), /`src\/lib\/greet.ts`/); // keyword match
  assert.match(context(root, "src/lib", 50), /truncated/);
  assert.throws(() => addNote(root, { kind: "idea", title: "x" }), /kind must be/);
});

test("edits, removes, and flags out-of-date notes", () => {
  const dir = copyFixture("sample");
  update(dir);
  const n = addNote(dir, { kind: "decision", title: "Greet stays pure", body: "no I/O", paths: ["src/lib/greet.ts", "src/lib"] });
  // only the passed fields change
  assert.deepEqual(
    pick(updateNote(dir, n.id, { title: "Greet is pure", body: undefined })),
    { kind: "decision", title: "Greet is pure", body: "no I/O", paths: ["src/lib/greet.ts", "src/lib"] },
  );
  assert.throws(() => updateNote(dir, n.id, { kind: "idea" }), /kind must be/);
  assert.throws(() => updateNote(dir, 99, { title: "x" }), /no note #99/);

  rmSync(join(dir, "src/lib/greet.ts"));
  assert.match(context(dir, "src/lib"), /#1 \[decision\] Greet is pure .*⚠ missing: src\/lib\/greet.ts$/m); // the folder still exists
  assert.match(renderMap(dir), /- #1 \[decision\] Greet is pure .*⚠ missing: src\/lib\/greet.ts/);
  updateNote(dir, n.id, { paths: ["src/lib"] });
  assert.doesNotMatch(renderMap(dir), /⚠/);

  removeNote(dir, n.id);
  assert.deepEqual(loadNotes(dir), []);
  assert.throws(() => removeNote(dir, n.id), /no note #1/);
});
const pick = ({ kind, title, body, paths }: Note) => ({ kind, title, body, paths });

test("reads CommonJS require and module.exports", () => {
  const cjs = copyFixture("cjs");
  const { index } = update(cjs);
  assert.deepEqual(index.files["User.js"].symbols.map((s) => [s.name, s.kind, s.exported]), [["User", "const", true]]); // module.exports = User
  const helpers = index.files["helpers.js"];
  assert.deepEqual(helpers.uses, { "User.js": ["User"] });
  const verify = helpers.symbols.find((s) => s.name === "verify")!;
  assert.equal(verify.exported, true);
  // User.findById -> User from User.js; jwt.verify is not our own verify; jwt is an external package
  assert.deepEqual(resolvedCalls(index, "helpers.js", verify.calls), [
    { name: "User", file: "User.js" },
    { name: "getToken", file: "helpers.js" },
  ]);
  const controller = index.files["controller.js"];
  assert.deepEqual(controller.uses, { "helpers.js": ["verify", "getToken"] }); // `getToken: token` keeps the exported name
  assert.deepEqual(controller.symbols.map((s) => [s.name, s.kind, s.exported, s.calls]), [["login", "function", true, ["getToken", "verify"]]]);
  // module.exports = mongoose.model(...) is named after the file, so `const Order = require("./Order")` finds it
  assert.deepEqual(index.files["Order.js"].symbols.map((s) => [s.name, s.exported]), [["Order", true]]);
  assert.deepEqual(resolvedCalls(index, "orders.js", index.files["orders.js"].symbols[0].calls), [{ name: "Order", file: "Order.js" }]);
});

test("finds where a symbol is defined and who uses it", () => {
  update(root);
  const out = findSymbol(root, "greet");
  assert.match(out, /function `greet` defined at `src\/lib\/greet.ts:1`/);
  assert.match(out, /used by `src\/main.ts` in: run/);
  assert.match(context(root, "greet"), /## Symbols/);
  assert.match(context(root, "src/main.ts"), /function `run` :4 \(exported\) → greet \(src\/lib\/greet.ts\)/);
  assert.match(findSymbol(root, "nope"), /No function or class/);
});

test("reads one symbol's source and re-indexes before answering", () => {
  update(root);
  assert.match(readSymbol(root, "App.start"), /`src\/main.ts:9-11`\n\n```\n  start\(\) \{\n    return run\("world"\);\n  \}\n```/);
  assert.match(readSymbol(root, "run"), /src\/main.ts:4-6/);
  // no update() call: the query itself picks up the new file
  writeFileSync(join(root, "src/extra.ts"), `export function extra() {\n  return 1;\n}\n`);
  assert.match(findSymbol(root, "extra"), /defined at `src\/extra.ts:1`/);
  assert.match(readSymbol(root, "extra"), /src\/extra.ts:1-3/);
  assert.match(readSymbol(root, "nope"), /No function or class/);
});

test("watch reacts only to indexed source files", () => {
  assert.ok(isSource("src\\lib\\greet.ts")); // Windows separators from fs.watch
  assert.ok(isSource("svc/app.py"));
  assert.ok(!isSource("README.md"));
  assert.ok(!isSource(".codemem/index.json")); // its own output must not retrigger it
  assert.ok(!isSource("node_modules\\x\\index.js"));
  assert.ok(!isSource("dist/src/cli.js"));
});

test("writes the graph page with embedded data", () => {
  addNote(root, { kind: "fix", title: "</script><b>xss", paths: ["src/main.ts"] });
  const html = readFileSync(writeGraph(root), "utf8");
  assert.match(html, /"path":"src\/main.ts"/);
  assert.match(html, /"entry":true/);
  // the note's "</script>" is escaped, so closing tags match the page's own opening tags
  assert.equal(html.match(/<\/script>/g)?.length, html.match(/<script/g)?.length);
});
