#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { context, findSymbol } from "./context.js";
import { writeGraph } from "./graph.js";
import { renderMap, update, writeMap } from "./index.js";
import { serve } from "./mcp.js";
import { addNote, KINDS, loadNotes } from "./notes.js";

const USAGE = `codemem <command> [--root <dir>]

  index [dir]                          update the memory (incremental)
  map                                  print the project map
  context <file|folder|symbol|keyword> [--budget N]
  symbol <name|Class.method>           where it is defined and who uses it
  note add --kind <${KINDS.join("|")}> [--paths a,b] "<title>" ["<body>"]
  note list
  graph [--no-open]                    write .codemem/graph.html and open it
  mcp                                  run the MCP server on stdio`;

// split "--name value" flags from positional args
const flags: Record<string, string> = {};
const args: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i] ?? "";
  else args.push(argv[i]);
}
const [cmd, ...rest] = args;
const root = resolve(flags.root ?? (cmd === "index" ? rest[0] : undefined) ?? ".");

try {
  if (cmd === "index") {
    const { index, parsed } = update(root);
    console.log(`Indexed ${Object.keys(index.files).length} files (${parsed} re-parsed) into ${root}/.codemem`);
  } else if (cmd === "map") {
    console.log(renderMap(root));
  } else if (cmd === "context" && rest[0]) {
    console.log(context(root, rest[0], flags.budget ? Number(flags.budget) : undefined));
  } else if (cmd === "symbol" && rest[0]) {
    console.log(findSymbol(root, rest[0]));
  } else if (cmd === "note" && rest[0] === "add") {
    const note = addNote(root, { kind: flags.kind, title: rest[1], body: rest[2], paths: flags.paths?.split(",") });
    writeMap(root);
    console.log(`Saved note #${note.id}.`);
  } else if (cmd === "note" && rest[0] === "list") {
    for (const n of loadNotes(root)) console.log(`#${n.id} [${n.kind}] ${n.title}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}`);
  } else if (cmd === "graph") {
    const file = writeGraph(root);
    console.log(`Wrote ${file}`);
    if (!("no-open" in flags)) {
      const [bin, ...open] = process.platform === "win32" ? ["cmd", "/c", "start", ""] : [process.platform === "darwin" ? "open" : "xdg-open"];
      spawn(bin, [...open, file], { detached: true, stdio: "ignore" }).unref();
    }
  } else if (cmd === "mcp") {
    await serve(root);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`codemem: ${(e as Error).message}`);
  process.exitCode = 1;
}
