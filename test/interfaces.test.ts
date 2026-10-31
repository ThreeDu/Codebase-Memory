import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadNotes } from "../src/notes.js";

// the built CLI, run as its own process the way people and agents run it
const CLI = join(import.meta.dirname, "../src/cli.js");
const sample = () => {
  const dir = mkdtempSync(join(tmpdir(), "codemem-"));
  cpSync(join(import.meta.dirname, "../../test/fixtures/sample"), dir, { recursive: true });
  return dir;
};
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const ok = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("CLI: index, map, context, symbol, read", () => {
  const root = sample();
  assert.match(ok("index", root), /Indexed 5 files \(5 re-parsed\)/);
  assert.match(ok("index", "--root", root), /Indexed 5 files \(0 re-parsed\)/);
  assert.match(ok("map", "--root", root), /## Entry points\n- `src\/main.ts`/);
  assert.match(ok("context", "src/lib", "--root", root), /`src\/lib\/greet.ts`/);
  assert.match(ok("context", "src/lib", "--budget", "40", "--root", root), /truncated/);
  assert.match(ok("symbol", "greet", "--root", root), /defined at `src\/lib\/greet.ts:2`[\s\S]*used by `src\/main.ts` in: run/);
  assert.match(ok("read", "App.start", "--root", root), /```\n  start\(\) \{\n    return run\("world"\);\n  \}\n```/);
  assert.match(ok("symbol", "nope", "--root", root), /No function or class named `nope`/);
  assert.match(ok("search", "greet", "--limit", "5", "--root", root), /function `greet` at `src\/lib\/greet.ts:2`/);
});

test("CLI: notes add, list, edit, rm", () => {
  const root = sample();
  assert.equal(ok("note", "add", "--kind", "decision", "--paths", "src/lib,src/gone.ts", "Barrel exports", "Import via index.ts", "--root", root).trim(), "Saved note #1.");
  assert.equal(ok("note", "list", "--root", root).trim(), "#1 [decision] Barrel exports (src/lib, src/gone.ts) ⚠ missing: src/gone.ts");
  assert.equal(ok("note", "edit", "1", "--paths", "src/lib", "--title", "Use the barrel", "--root", root).trim(), "Updated note #1.");
  assert.equal(ok("note", "list", "--root", root).trim(), "#1 [decision] Use the barrel (src/lib)");
  assert.match(ok("map", "--root", root), /- #1 \[decision\] Use the barrel \(src\/lib\)/);
  assert.equal(ok("note", "rm", "1", "--root", root).trim(), "Removed note #1.");
  assert.equal(ok("note", "list", "--root", root), "");
});

test("CLI: errors exit 1 with a message on stderr", () => {
  const root = sample();
  const fails = (pattern: RegExp, ...args: string[]) => {
    const r = run(...args, "--root", root);
    assert.equal(r.status, 1, `${args.join(" ")} should fail`);
    assert.match(r.stderr, pattern);
  };
  fails(/codemem: kind must be one of: decision, convention, fix/, "note", "add", "--kind", "idea", "x");
  fails(/codemem: title is required/, "note", "add", "--kind", "fix");
  fails(/codemem: no note #99/, "note", "rm", "99");
  fails(/codemem: no note #99/, "note", "edit", "99", "--title", "x");
  fails(/^codemem <command>/, "frobnicate"); // unknown command: usage
  fails(/^codemem <command>/, "symbol"); // missing argument: usage
});

test("CLI: a flag without a value doesn't swallow the next flag", () => {
  const root = sample();
  // --no-open before --root: --root must still apply (it used to become --no-open's value)
  assert.match(ok("graph", "--no-open", "--root", root), /Wrote .*graph\.html/);
  assert.ok(existsSync(join(root, ".codemem/graph.html")));
});

// several agents (or an agent and `codemem watch`) working on one repo at the same time
test("CLI: concurrent processes don't lose notes or read a half-written index", async () => {
  const root = sample();
  const start = (...args: string[]) =>
    new Promise<{ status: number | null; out: string; err: string }>((done) => {
      const p = spawn(process.execPath, [CLI, ...args, "--root", root]);
      let [out, err] = ["", ""];
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (status) => done({ status, out, err }));
    });
  // no index yet: six processes build it while three others add notes
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => start("symbol", "greet")),
    ...Array.from({ length: 3 }, (_, i) => start("note", "add", "--kind", "fix", `Note ${i}`)),
  ]);
  for (const r of results) assert.equal(r.status, 0, r.err);
  for (const r of results.slice(0, 6)) assert.match(r.out, /defined at `src\/lib\/greet.ts:2`/);
  const notes = loadNotes(root);
  assert.deepEqual(notes.map((n) => n.id).sort(), [1, 2, 3]); // all kept, no id handed out twice
  assert.deepEqual(notes.map((n) => n.title).sort(), ["Note 0", "Note 1", "Note 2"]);
  assert.deepEqual(readdirSync(join(root, ".codemem")).filter((f) => /\.(tmp|lock)$/.test(f)), []); // nothing left behind
});

test("a damaged index is rebuilt; damaged notes are reported, never overwritten", () => {
  const root = sample();
  ok("index", root);
  writeFileSync(join(root, ".codemem/index.json"), '{"version":8,"files":{"src/ma'); // cut off mid-write
  assert.match(ok("symbol", "greet", "--root", root), /defined at/);
  writeFileSync(join(root, ".codemem/notes.json"), "[{ broken");
  const r = run("note", "add", "--kind", "fix", "x", "--root", root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /notes.json is not valid JSON/);
  assert.equal(readFileSync(join(root, ".codemem/notes.json"), "utf8"), "[{ broken");
});

test("MCP: every tool over a real stdio connection", async () => {
  const root = sample();
  const client = new Client({ name: "codemem-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--root", root] }));
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: (r.content as { text: string }[])[0].text, isError: !!r.isError };
    };
    assert.equal(client.getServerVersion()?.version, JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")).version);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_note", "find_symbol", "get_context", "get_map", "read_symbol", "reindex", "remove_note", "search_symbols", "update_note",
    ]);

    // no index yet: the first query builds it
    assert.match((await call("get_map")).text, /## Entry points\n- `src\/main.ts`/);
    assert.match((await call("reindex")).text, /^Indexed 5 files \(0 re-parsed\)/);
    assert.match((await call("get_context", { target: "src/lib" })).text, /imported by: src\/main.ts/);
    assert.match((await call("find_symbol", { name: "greet" })).text, /used by `src\/main.ts` in: run/);
    assert.match((await call("read_symbol", { name: "run" })).text, /`src\/main.ts:4-6`/);
    assert.match((await call("search_symbols", { query: "app start" })).text, /method `App.start` at `src\/main.ts:9`/);
    assert.ok((await call("search_symbols", { query: "x", limit: 0 })).isError); // limit must be positive

    // a file written while the server runs is found without calling reindex
    writeFileSync(join(root, "src/extra.ts"), "export function extra() {\n  return 1;\n}\n");
    assert.match((await call("find_symbol", { name: "extra" })).text, /defined at `src\/extra.ts:1`/);

    // notes round trip, visible in context
    assert.equal((await call("add_note", { kind: "convention", title: "Pure greet", paths: ["src/lib/greet.ts"] })).text, "Saved note #1.");
    assert.match((await call("get_context", { target: "greet" })).text, /### #1 \[convention\] Pure greet/);
    assert.equal((await call("update_note", { id: 1, body: "no I/O" })).text, "Updated note #1.");
    assert.match((await call("get_context", { target: "greet" })).text, /Pure greet[^\n]*\nno I\/O/);
    assert.equal((await call("remove_note", { id: 1 })).text, "Removed note #1.");
    assert.doesNotMatch((await call("get_map")).text, /Pure greet/);

    // bad input comes back as a tool error, and the server keeps working
    const missing = await call("update_note", { id: 99, title: "x" });
    assert.ok(missing.isError);
    assert.match(missing.text, /no note #99/);
    assert.ok((await call("add_note", { kind: "idea", title: "x" })).isError); // not one of the kinds
    assert.ok((await call("find_symbol", { name: "" })).isError); // empty name
    assert.match((await call("find_symbol", { name: "greet" })).text, /defined at/);
  } finally {
    await client.close();
  }
});
