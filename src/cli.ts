#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { context, findSymbol, readSymbol, searchSymbols } from "./context.js";
import { writeGraph } from "./graph.js";
import { isSource, renderMap, update, writeMap } from "./index.js";
import { serve } from "./mcp.js";
import { addNote, KINDS, loadNotes, removeNote, staleMark, updateNote } from "./notes.js";

const USAGE = `codemem <command> [--root <dir>]

  index [dir]                          update the memory (incremental)
  map                                  print the project map
  context <file|folder|symbol|keyword> [--budget N]
  symbol <name|Class.method>           where it is defined and who uses it
  read <name|Class.method>             print its source code
  search <words...> [--limit N]        find functions/classes by rough name ("payment webhook")
  note add --kind <${KINDS.join("|")}> [--paths a,b] "<title>" ["<body>"]
  note edit <id> [--kind K] [--title T] [--body B] [--paths a,b]
  note rm <id>
  note list                            ⚠ marks notes whose paths no longer exist
  graph [--no-open]                    write .codemem/graph.html and open it
  watch                                keep map.md and graph.html updated as code changes
  mcp                                  run the MCP server on stdio`;

// split "--name value" flags from positional args; a flag followed by another flag (--no-open --root x) has no value
const flags: Record<string, string> = {};
const args: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "" : (argv[++i] ?? "");
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
  } else if (cmd === "read" && rest[0]) {
    console.log(readSymbol(root, rest[0]));
  } else if (cmd === "search" && rest[0]) {
    console.log(searchSymbols(root, rest.join(" "), flags.limit ? Number(flags.limit) : undefined));
  } else if (cmd === "note" && rest[0] === "add") {
    const note = addNote(root, { kind: flags.kind, title: rest[1], body: rest[2], paths: flags.paths?.split(",") });
    writeMap(root);
    console.log(`Saved note #${note.id}.`);
  } else if (cmd === "note" && rest[0] === "edit" && rest[1]) {
    const { kind, title, body, paths } = flags;
    const note = updateNote(root, Number(rest[1]), { kind, title, body, paths: paths?.split(",") });
    writeMap(root);
    console.log(`Updated note #${note.id}.`);
  } else if (cmd === "note" && rest[0] === "rm" && rest[1]) {
    removeNote(root, Number(rest[1]));
    writeMap(root);
    console.log(`Removed note #${rest[1]}.`);
  } else if (cmd === "note" && rest[0] === "list") {
    for (const n of loadNotes(root))
      console.log(`#${n.id} [${n.kind}] ${n.title}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}${staleMark(root, n)}`);
  } else if (cmd === "graph") {
    const file = writeGraph(root);
    console.log(`Wrote ${file}`);
    if (!("no-open" in flags)) {
      const [bin, ...open] = process.platform === "win32" ? ["cmd", "/c", "start", ""] : [process.platform === "darwin" ? "open" : "xdg-open"];
      spawn(bin, [...open, file], { detached: true, stdio: "ignore" }).unref();
    }
  } else if (cmd === "watch") {
    const run = () => {
      try {
        writeGraph(root); // re-indexes, which also rewrites map.md
        console.log(`${new Date().toLocaleTimeString()} updated map and graph`);
      } catch (e) {
        console.error(`codemem: ${(e as Error).message}`); // e.g. a file mid-save; the next change retries
      }
    };
    run();
    let timer: NodeJS.Timeout | undefined;
    // debounced: one save often fires several events, and a branch switch fires hundreds
    watch(root, { recursive: true }, (_, file) => {
      if (!file || !isSource(file)) return;
      clearTimeout(timer);
      timer = setTimeout(run, 300);
    });
    console.log(`Watching ${root} (Ctrl+C to stop)`);
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
