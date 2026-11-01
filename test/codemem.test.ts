import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { affected, context, findSymbol, formatAffected, readSymbol, searchSymbols } from "../src/context.js";
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

const kinds = (index: ReturnType<typeof update>["index"], f: string) =>
  index.files[f].symbols.map((s) => [s.kind, s.parent ? `${s.parent}.${s.name}` : s.name, s.line, s.end]);
const callsOf = (index: ReturnType<typeof update>["index"], f: string, name: string) =>
  resolvedCalls(index, f, index.files[f].symbols.find((s) => s.name === name)!.calls).map((c) => `${c.name}@${c.file}`);

test("reads Go: module imports, same-package files, methods", () => {
  const go = copyFixture("gosample");
  const { index } = update(go);
  // a package import is every non-test file of that folder; util.go is the same package, used without an import
  assert.deepEqual(index.files["main.go"].imports, ["internal/store/store.go", "util.go"]);
  assert.deepEqual(index.files["main.go"].external, ["fmt"]);
  assert.deepEqual(index.files["internal/store/store.go"].external, ["github.com/google/uuid"]);
  assert.deepEqual(entryPoints(go, index), ["main.go"]); // store_test.go is a test
  assert.deepEqual(kinds(index, "internal/store/store.go"), [["class", "Store", 6, 8], ["function", "New", 10, 12], ["method", "Store.Count", 14, 16]]);
  // `type Label string` has no body; the "{" inside a string doesn't open one
  assert.deepEqual(kinds(index, "util.go"), [["type", "Label", 3, 3], ["function", "greeting", 5, 7], ["function", "itoa", 9, 9]]);
  assert.deepEqual(callsOf(index, "main.go", "main"), ["New@internal/store/store.go", "greeting@util.go"]);
  assert.match(findSymbol(go, "greeting"), /used by `main.go` in: main/);
  assert.match(readSymbol(go, "Store.Count"), /store.go:14-16`\n\n```\nfunc \(s \*Store\) Count\(\) int \{\n\treturn len\(s.items\)\n\}\n```/);
});

test("re-index after an edit updates links around the edited file only", () => {
  const go = copyFixture("gosample");
  update(go);
  const later = new Date(Date.now() + 5000);
  // re-saved unchanged (new mtime): nothing re-parsed, links kept
  utimesSync(join(go, "util.go"), later, later);
  assert.equal(update(go).parsed, 0);
  assert.deepEqual(update(go).index.files["main.go"].imports, ["internal/store/store.go", "util.go"]);
  // greeting renamed: main.go (an importer of util.go, not itself edited) loses the link
  writeFileSync(join(go, "util.go"), `package main\n\nfunc greet2(n int) string {\n\treturn ""\n}\n`);
  let { index, parsed } = update(go);
  assert.equal(parsed, 1);
  assert.deepEqual(index.files["main.go"].imports, ["internal/store/store.go"]);
  // main.go edited to stop importing the store package
  writeFileSync(join(go, "main.go"), `package main\n\nfunc main() {\n\tgreet2(1)\n}\n`);
  ({ index } = update(go));
  assert.deepEqual(index.files["main.go"].imports, ["util.go"]);
  assert.deepEqual(index.files["main.go"].external, []);
});

test("reads Java: class imports, wildcard and same-package, methods", () => {
  const java = copyFixture("javasample");
  const { index } = update(java);
  const src = "src/main/java/com/shop/";
  assert.deepEqual(index.files[`${src}App.java`].imports, [`${src}UserService.java`, `${src}model/User.java`]);
  assert.deepEqual(index.files[`${src}App.java`].external, ["java.util"]);
  assert.deepEqual(index.files[`${src}UserService.java`].imports, [`${src}model/User.java`]); // import com.shop.model.*
  assert.deepEqual(entryPoints(java, index), [`${src}App.java`]); // AppTest is under src/test
  // a field initializer and statements aren't methods; a constructor is; the javadoc's "{" is ignored
  assert.deepEqual(kinds(index, `${src}UserService.java`), [["class", "UserService", 9, 19], ["method", "UserService.UserService", 10, 11], ["method", "UserService.all", 13, 18]]);
  assert.deepEqual(kinds(index, `${src}model/User.java`), [["class", "User", 3, 4]]);
  assert.deepEqual(callsOf(index, `${src}App.java`, "App"), [`User@${src}model/User.java`, `UserService@${src}UserService.java`]);
  assert.match(findSymbol(java, "User"), /used by `src\/main\/java\/com\/shop\/UserService.java` in: UserService, UserService.all/);
});

test("reads Rust: mod, use (groups, as, super, re-exports), impl methods", () => {
  const rs = copyFixture("rustsample");
  const { index } = update(rs);
  assert.deepEqual(index.files["src/main.rs"].imports, ["src/models/mod.rs", "src/util.rs"]);
  assert.deepEqual(index.files["src/main.rs"].external, ["serde"]);
  assert.deepEqual(index.files["src/util.rs"].imports, ["src/models/mod.rs"]); // super::models
  assert.deepEqual(index.files["src/models/mod.rs"].imports, ["src/models/status.rs"]);
  assert.deepEqual(entryPoints(rs, index), ["src/main.rs"]);
  assert.deepEqual(kinds(index, "src/models/mod.rs"), [["class", "Order", 5, 7], ["method", "Order.new", 10, 12], ["method", "Order.total", 14, 16]]);
  assert.deepEqual(kinds(index, "src/models/status.rs"), [["class", "Status", 2, 5]]);
  // `Status as OrderStatus` maps back to Status, which `pub use` re-exports from status.rs; util::describe via `mod util;`
  assert.deepEqual(callsOf(index, "src/main.rs", "main"), ["Order@src/models/mod.rs", "Status@src/models/status.rs", "describe@src/util.rs"]);
  assert.match(readSymbol(rs, "Order.total"), /mod.rs:14-16`/);
});

test("reads C: includes, header -> source pairs, prototypes vs definitions", () => {
  const c = copyFixture("csample");
  const { index } = update(c);
  // "../include/util.h" by path; "util.h" from src/ found like an include dir; util.c implements what main calls
  assert.deepEqual(index.files["src/main.c"].imports, ["include/util.h", "src/util.c"]);
  assert.deepEqual(index.files["src/main.c"].external, ["stdio.h"]);
  assert.deepEqual(index.files["src/util.c"].imports, ["include/util.h"]);
  assert.deepEqual(entryPoints(c, index), ["src/main.c"]); // util.c is used through its header
  assert.deepEqual(index.files["include/util.h"].symbols, []); // prototypes (one spans two lines) only declare
  assert.deepEqual(kinds(index, "src/util.c"), [["function", "helper", 4, 4], ["function", "add", 6, 9], ["function", "twice", 11, 14]]);
  assert.equal(index.files["src/util.c"].symbols[0].exported, false); // static
  assert.deepEqual(callsOf(index, "src/main.c", "main"), ["twice@src/util.c"]);
});

test("reads C++: classes in a namespace, Class::method definitions", () => {
  const cpp = copyFixture("cppsample");
  const { index } = update(cpp);
  assert.deepEqual(index.files["src/main.cpp"].imports, ["include/shapes/Shape.hpp", "src/Shape.cpp"]);
  assert.deepEqual(index.files["src/main.cpp"].external, ["iostream", "memory"]);
  assert.deepEqual(entryPoints(cpp, index), ["src/main.cpp"]);
  // `public:` at the class's indent doesn't end it; constructor, destructor, pure virtual, inline body
  assert.deepEqual(kinds(index, "include/shapes/Shape.hpp"), [
    ["class", "Shape", 6, 15], ["method", "Shape.Shape", 8, 8], ["method", "Shape.~Shape", 9, 9],
    ["method", "Shape.area", 10, 10], ["method", "Shape.name", 11, 11],
    ["class", "Circle", 17, 24], ["method", "Circle.Circle", 19, 19], ["method", "Circle.area", 20, 20],
  ]);
  assert.deepEqual(kinds(index, "src/Shape.cpp"), [["method", "Shape.Shape", 5, 5], ["method", "Circle.Circle", 7, 7], ["method", "Circle.area", 9, 11]]);
  assert.match(findSymbol(cpp, "Circle.area"), /Shape.hpp:20`[\s\S]*Shape.cpp:9`/); // declared and defined
});

test("reads C#: namespaces across files, usings, block and file-scoped namespaces", () => {
  const cs = copyFixture("cssample");
  const { index } = update(cs);
  assert.deepEqual(index.files["Program.cs"].imports, ["Services/OrderService.cs"]); // `using Shop.Services`
  assert.deepEqual(index.files["Services/OrderService.cs"].imports, ["Models/Order.cs"]);
  assert.deepEqual(index.files["Services/OrderService.cs"].external, ["System.Linq"]);
  assert.deepEqual(index.files["Shop.Tests/OrderServiceTests.cs"].external, ["Xunit"]);
  assert.deepEqual(entryPoints(cs, index), ["Program.cs"]); // Main; Shop.Tests/ is a test project
  assert.deepEqual(kinds(index, "Program.cs"), [["class", "Program", 5, 12], ["method", "Program.Main", 7, 11]]); // inside `namespace Shop { }`
  // a field initializer and an attribute aren't methods; constructor, expression body, async generic return are
  assert.deepEqual(kinds(index, "Services/OrderService.cs"), [
    ["class", "OrderService", 6, 19], ["method", "OrderService.OrderService", 10, 10],
    ["method", "OrderService.Total", 12, 12], ["method", "OrderService.TotalAsync", 15, 18],
  ]);
  assert.deepEqual(kinds(index, "Models/Order.cs"), [["class", "Order", 3, 3], ["class", "Helper", 5, 7]]);
  assert.match(findSymbol(cs, "OrderService"), /used by `Program.cs` in: Program, Program.Main/);
});

test("handles patterns found in real repos", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  const put = (f: string, src: string) => {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), src);
  };
  // Python app whose main.py is imported back by the UI for helpers (a cycle): it still runs on its own
  put("main.py", `import ui\n\ndef get_dir():\n    return "."\n\nif __name__ == "__main__":\n    ui.start()\n`);
  put("ui/__init__.py", "");
  put("ui/app.py", `def start():\n    from main import get_dir\n    return get_dir()\n`);
  put("config.py", `PORT = 1\n`);
  // Rust binary calling its own library by crate name ("my-app" -> my_app), plus a crate used without `use`
  put("Cargo.toml", `[package]\nname = "my-app"\n\n[dependencies]\nserde_json = "1"\n`);
  put("src/lib.rs", `pub fn run() {}\n`);
  put("src/main.rs", `fn main() {\n    my_app::run();\n    let _ = serde_json::to_string(&1);\n}\n`);
  // end lines: a ";" inside an array type in a multi-line signature, and a "{" in a Go raw string
  put("src/hash.rs", `pub fn finish(\n    out: [u8; 32],\n) -> [u8; 32] {\n    out\n}\n`);
  put("raw.go", "package main\n\nfunc body() []byte {\n\treturn []byte(`{`)\n}\n");
  const { index } = update(dir);
  assert.ok(entryPoints(dir, index).includes("main.py"));
  assert.deepEqual(index.files["src/main.rs"].imports, ["src/lib.rs"]);
  assert.deepEqual(index.files["src/main.rs"].external, ["serde_json"]);
  assert.deepEqual(callsOf(index, "src/main.rs", "main"), ["run@src/lib.rs"]);
  assert.deepEqual(kinds(index, "src/hash.rs"), [["function", "finish", 1, 5]]);
  assert.deepEqual(kinds(index, "raw.go"), [["function", "body", 3, 5]]);
  // one heading per folder even though "config.py" < "main.py" sort around "src/" and "ui/"
  assert.equal(renderMap(dir, index).match(/^### \(root\)$/gm)?.length, 1);
});

test("resolves tsconfig paths and jsconfig baseUrl aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  const put = (f: string, src: string) => {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), src);
  };
  // Next/Vite style: "@/*" -> "src/*", in a config with comments and a trailing comma
  put("tsconfig.json", `{\n  // aliases\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], "~ui": ["src/ui/index.ts"], "*": ["src/*"] }, },\n}\n`);
  put("src/lib/util.ts", `export const util = 1;\n`);
  put("src/ui/index.ts", `export const Button = 1;\n`);
  put("src/app.ts", `import { util } from "@/lib/util";\nimport { Button } from "~ui";\nimport { gone } from "@/missing";\nimport React from "react";\n`);
  // CRA style in a subfolder: bare imports from baseUrl
  put("web/jsconfig.json", `{ "compilerOptions": { "baseUrl": "src" } }`);
  put("web/src/components/Card.js", `export default function Card() {}\n`);
  put("web/src/index.js", `import Card from "components/Card";\nimport axios from "axios";\n`);
  const { index } = update(dir);
  assert.deepEqual(index.files["src/app.ts"].imports, ["src/lib/util.ts", "src/ui/index.ts"]);
  assert.deepEqual(index.files["src/app.ts"].external, ["react"]); // "@/missing" is ours, just missing; "*" doesn't swallow react
  assert.deepEqual(index.files["web/src/index.js"].imports, ["web/src/components/Card.js"]);
  assert.deepEqual(index.files["web/src/index.js"].external, ["axios"]);
});

test("searches symbols by rough name or words", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  const put = (f: string, src: string) => {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), src);
  };
  put("server/payments.ts", `export function handlePaymentWebhook() {}\nexport class PaymentService {\n  refund() {}\n}\n`);
  put("server/orders.ts", `export function listOrders() {}\nexport function paymentWebhookUrl() {}\n`);
  put("ml/config.py", `def parse_config(path):\n    return path\n`);
  const lines = (q: string) => searchSymbols(dir, q).split("\n").filter((l) => l.startsWith("- "));
  // every word must match; "handler" finds "handle"; the closer name ranks first
  assert.deepEqual(lines("payment webhook handler"), ["- function `handlePaymentWebhook` at `server/payments.ts:1` (exported)"]);
  assert.match(lines("payment webhook")[0], /handlePaymentWebhook|paymentWebhookUrl/);
  assert.equal(lines("payment webhook").length, 2);
  assert.match(lines("parseConfig")[0], /function `parse_config` at `ml\/config.py:1`/); // camelCase query, snake_case name
  assert.match(lines("payment refund")[0], /method `PaymentService.refund`/); // the class name counts for a method
  assert.match(lines("PaymentService")[0], /class `PaymentService`/); // exact name first, before its methods
  assert.match(searchSymbols(dir, "invoice"), /No function, class or method matches `invoice`/);
  assert.match(searchSymbols(dir, "pay", 1), /…and \d+ more/);
  // tests rank below the code they test, unless the query asks for tests
  put("server/payments.test.ts", `export function handlePaymentWebhookCase() {}\n`);
  assert.match(lines("handle payment webhook")[0], /server\/payments.ts/);
  assert.match(lines("payment webhook test")[0], /server\/payments.test.ts/);
  // no name has every word: the closest ones instead of nothing
  assert.match(searchSymbols(dir, "payment webhook invoice"), /none has every word: closest first[\s\S]*handlePaymentWebhook/);
});

test("affected: dependents through several hops, and the tests among them", () => {
  const dir = copyFixture("sample");
  // greet.ts <- lib/index.ts (barrel) <- main.ts <- main.test.ts
  assert.deepEqual(affected(dir, ["src/lib/greet.ts"]), {
    tests: ["src/main.test.ts"],
    files: [["src/lib/index.ts", 1], ["src/main.ts", 2]],
    unknown: [],
  });
  assert.deepEqual(affected(dir, ["src/lib/greet.ts"], 1).files, [["src/lib/index.ts", 1]]); // depth limit
  assert.deepEqual(affected(dir, ["./src/main.test.ts", "README.md"]), { tests: ["src/main.test.ts"], files: [], unknown: ["README.md"] });
  assert.match(formatAffected(dir, ["src/orphan.ts"]), /No test depends on these files within 5 import hops/);
});

test("read_symbol shows who uses it and whether a test does", () => {
  const dir = copyFixture("sample");
  const greet = readSymbol(dir, "greet");
  assert.match(greet, /Used by: `src\/lib\/index.ts`; `src\/main.ts` \(run\)/);
  assert.match(greet, /⚠ No test file uses it directly/);
  assert.match(readSymbol(dir, "App.start"), /Callers of methods aren't tracked/);
  assert.match(readSymbol(dir, "App"), /Used by: nothing in the indexed code/);
});

test("WHY/NOTE comments become notes attached to the code they explain", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  const put = (f: string, src: string) => {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), src);
  };
  put("src/retry.ts", [
    "// HACK: upstream sends dates without a timezone",
    "export function retry() {",
    "  // WHY: 3 tries, because the gateway rate-limits",
    "  // at 4 calls a minute per key",
    "  return 3;",
    "}",
    "",
    "// Note: ordinary prose isn't a tag",
    "/* NOTE: token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB for the mock */",
    "export const MOCK = 1;",
  ].join("\n"));
  put("ml/train.py", "# DECISION: train on CPU so CI needs no GPU\ndef train():\n    return 1\n");
  const { index } = update(dir);
  assert.deepEqual(index.files["src/retry.ts"].whys, [
    { line: 1, tag: "HACK", text: "upstream sends dates without a timezone" },
    { line: 3, tag: "WHY", text: "3 tries, because the gateway rate-limits at 4 calls a minute per key" }, // two lines joined
    { line: 9, tag: "NOTE", text: "token=[redacted] for the mock" }, // secrets never stored
  ]);
  const ctx = context(dir, "src/retry.ts");
  assert.match(ctx, /- HACK :1 \(retry\): upstream sends dates/); // the comment just above a definition is about it
  assert.match(ctx, /- WHY :3 \(retry\): 3 tries/); // inside it, too
  assert.match(ctx, /- NOTE :9 \(MOCK\): token=\[redacted\]/);
  assert.match(readSymbol(dir, "retry"), /Comments about it:\n- HACK \(line 1\): upstream[^\n]*\n- WHY \(line 3\): 3 tries/);
  assert.match(context(dir, "ml"), /- DECISION :1 \(train\): train on CPU/);
});

test("files over 5 MB are known but never read", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/huge.js"), `export function hidden() {}\n// ${"x".repeat(5 * 1024 * 1024)}\n`);
  writeFileSync(join(dir, "src/app.js"), `import { hidden } from "./huge.js";\nexport const run = () => hidden();\n`);
  const { index } = update(dir);
  assert.equal(index.files["src/huge.js"].oversize, true);
  assert.deepEqual(index.files["src/huge.js"].symbols, []);
  assert.deepEqual(index.files["src/app.js"].imports, ["src/huge.js"]); // imports to it still resolve
  assert.match(renderMap(dir, index), /`src\/huge.js` \(over 5 MB, not read\)/);
  // shrinking it under the limit gets it read
  writeFileSync(join(dir, "src/huge.js"), "export function hidden() {}\n");
  assert.deepEqual(update(dir).index.files["src/huge.js"].symbols.map((s) => s.name), ["hidden"]);
});

test("watch reacts only to indexed source files", () => {
  assert.ok(isSource("src\\lib\\greet.ts")); // Windows separators from fs.watch
  assert.ok(isSource("svc/app.py"));
  assert.ok(!isSource("README.md"));
  assert.ok(!isSource(".codemem/index.json")); // its own output must not retrigger it
  assert.ok(!isSource("node_modules\\x\\index.js"));
  assert.ok(!isSource("dist/src/cli.js"));
  assert.ok(!isSource("vendor/github.com/x/y.go")); // vendored dependencies
  assert.ok(!isSource("src/third_party/zlib/inflate.c"));
});

test("writes the graph page with embedded data", () => {
  addNote(root, { kind: "fix", title: "</script><b>xss", paths: ["src/main.ts"] });
  const html = readFileSync(writeGraph(root), "utf8");
  assert.match(html, /"path":"src\/main.ts"/);
  assert.match(html, /"entry":true/);
  // the note's "</script>" is escaped, so closing tags match the page's own opening tags
  assert.equal(html.match(/<\/script>/g)?.length, html.match(/<script/g)?.length);
  // a note about a deleted file carries its warning into the page
  addNote(root, { kind: "decision", title: "Old file rule", paths: ["src/deleted.ts"] });
  assert.match(readFileSync(writeGraph(root), "utf8"), /"title":"Old file rule"[^}]*"stale":"⚠ missing: src\/deleted.ts"/);
});
