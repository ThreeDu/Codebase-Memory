import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { context } from "../src/context.js";
import { entryPoints, update } from "../src/index.js";
import { addNote } from "../src/notes.js";

// copy the fixture outside this git repo so the plain directory walk is used and nothing is written into the repo
const root = mkdtempSync(join(tmpdir(), "codemem-"));
cpSync(join(import.meta.dirname, "../../test/fixtures/sample"), root, { recursive: true });

test("builds the import graph", () => {
  const { index, parsed } = update(root);
  assert.equal(parsed, 5);
  assert.deepEqual(index.files["src/main.ts"].imports, ["src/lib/index.ts"]); // "./lib/index.js" -> .ts
  assert.deepEqual(index.files["src/main.ts"].external, ["chalk"]);
  assert.deepEqual(index.files["src/lib/index.ts"].imports, ["src/lib/greet.ts"]); // extensionless
  assert.deepEqual(index.files["src/lib/greet.ts"].external, ["node:path"]);
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
