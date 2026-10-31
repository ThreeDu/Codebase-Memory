# Codebase-Memory

Long-term memory for a codebase, so AI coding agents pick up its architecture without re-scanning everything.

- **Module map**: every TS/JS, Python, Go, Java, Rust, C/C++, and C# file with its resolved imports and packages, plus its entry points and most depended-on modules.
- **Symbols**: the functions, classes, and methods each file defines, which names it takes from which file, and which of those each function calls, so you can ask where `ChurnPredictor` is defined and which functions use it.
- **Notes**: architecture decisions, code conventions, and bugs that were already fixed, each attached to the files or folders it's about.
- **Incremental**: unchanged files aren't even read (same modification time and size), only changed content is re-parsed, and after an edit only the files around it are re-resolved. Tested on Kubernetes, LLVM, MongoDB, VS Code, Next.js, Godot, Django, React and Express.
- **Selective context**: an agent asks about a file, folder, or keyword and gets back only the relevant notes, plus those files with their imports and importers.

Everything lives in `.codemem/` inside the target repo (`index.json`, `notes.json`, `map.md`). Commit `notes.json` (and `map.md` if you like) so every agent and teammate shares the same memory; `index.json` is a cache that rebuilds itself, and on a big repo it's 100MB+, so leave it out of git. Agents without MCP can simply read `.codemem/map.md`.

Full installation and usage guide, with examples for every command: [docs/USAGE.md](docs/USAGE.md).

## Install

```bash
npm install && npm run build
```

## CLI

```bash
node dist/src/cli.js index path/to/repo
```

| Command | What it does |
|---|---|
| `index [dir]` | Create or update the memory (incremental) |
| `map` | Print the project map |
| `context <file\|folder\|symbol\|keyword> [--budget N]` | Focused context, cut at N chars (default 8000) |
| `symbol <name\|Class.method>` | Where a function/class is defined and which files and functions use it |
| `read <name\|Class.method>` | Print just that function/class/method's source, with its line range |
| `note add --kind decision\|convention\|fix [--paths a,b] "<title>" ["<body>"]` | Save a note |
| `note edit <id> [--kind K] [--title T] [--body B] [--paths a,b]` | Change only the given fields of a note |
| `note rm <id>` | Delete a note |
| `note list` | List notes; `⚠ missing` marks notes whose files/folders were renamed or deleted |
| `graph [--no-open]` | Re-index, write `.codemem/graph.html`, and open it in the browser |
| `watch` | Keep `map.md` and `graph.html` updated as code changes (refresh the browser to see it) |
| `mcp` | Run as an MCP server on stdio |

All commands accept `--root <dir>` (default: the current directory). After `npm link` you can call the CLI as `codemem`.

## Graph view

`codemem graph` opens an interactive map of the whole codebase: folders are boxes, files are dots (bigger = more importers, orange ring = entry point), arrows are imports. Click a file to highlight what it imports and what imports it (highlighted arrows show the imported names), with its functions/classes, what each one calls, and its notes in the side panel; click a folder for its files; type a file or function name in the search box and press Enter to jump to it. The page is a single file with the data embedded (it loads Cytoscape and its fcose layout from cdnjs/jsDelivr, so it needs internet). It's regenerated on every run, so you may want `.codemem/graph.html` in the target repo's `.gitignore`.

## Use from Claude Code (MCP)

```bash
claude mcp add codemem -- node /path/to/Codebase-Memory/dist/src/cli.js mcp --root .
```

Replace `/path/to/Codebase-Memory` with where you cloned this repo (e.g. `C:/tools/Codebase-Memory` or `~/tools/Codebase-Memory`). After `npm link` you can skip the path: `claude mcp add codemem -- codemem mcp --root .` (on Windows: `-- cmd /c codemem mcp --root .`).

Tools: `reindex`, `get_map`, `get_context`, `find_symbol`, `read_symbol`, `add_note`, `update_note`, `remove_note`. A good line for the target repo's `CLAUDE.md`/`AGENTS.md`:

> Before working on an area, call `get_context` for it; read a single function with `read_symbol` instead of the whole file. Record decisions, conventions, and non-obvious bug fixes with `add_note`; fix or remove notes marked `⚠ missing` or no longer true.

Or give Claude Code the full usage guide as a skill: `cp -r skills/codemem ~/.claude/skills/` (see [docs/USAGE.md](docs/USAGE.md#or-install-the-skill-claude-code)).

## Limits (v1)

- Parses TS/JS (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, ES modules and CommonJS), Python (`.py`), Go (`.go`), Java (`.java`), Rust (`.rs`), C/C++ (`.c .h .cc .cpp .cxx .hh .hpp .hxx`), and C# (`.cs`).
- C/C++: `#include "x.h"` is looked up next to the file, then (like `<x.h>`) as any repo file ending in that path; an included header also links to the file implementing it (`util.h` -> `util.c`, the same name next to it or the only one in the repo). Prototypes are skipped so calls go to the definition; `Foo::bar` is method `bar` of `Foo`. Definitions are expected at the top level or inside an unindented `namespace x {`.
- C#: a file is linked to the files of each namespace in view (its own and its parents, plus every `using`) whose types it mentions; `namespace X { }` and file-scoped `namespace X;` both work. `global using` applies only to the file it's written in.
- Go, Java, Rust, C/C++, C#: found by regex on conventionally formatted code (gofmt, rustfmt, top-level types at column 0). Go imports of the module in `go.mod` resolve to every non-test file in that package's folder; Java `a.b.C` resolves to the file ending in `a/b/C.java` under any source root; Rust follows `mod x;`, `use crate::/self::/super::`, groups, `as`, and `pub use` re-exports. Go and Java files are linked to files of their own package (same folder) whose functions/types they use. Braces inside block comments or multi-line strings can throw off a definition's end line.
- Symbols: top-level functions, classes, methods, exported constants (TS/JS) and module CONSTANTS (Python). Calls are matched by name, so a method called through an instance (`obj.train()`) is not tracked; a default import or `module.exports = expr` is matched by its local name / the file name.
- Python: imports and symbols are found by regex, and absolute imports are looked up from the importing file's folder up to the repo root (so a service folder like `ml-service/` works as its own source root), then `src/`.
- TS/JS aliases: `paths` and `baseUrl` from every `tsconfig*.json` / `jsconfig.json` are applied to files under that config's folder; `extends` is not followed.
- `context`, `symbol`, `read` and the MCP tools re-index before answering. With nothing changed that's a check of every file's modification time: about 1–2 s on Kubernetes (14k files), 6–9 s on LLVM (77k). After an edit the whole index file is rewritten, which costs more on huge repos (about 5 s on Kubernetes, 14 s on LLVM). `codemem watch` is the opt-in file watcher.
- Skipped: build output (`dist`, `build`, `target`, `obj`) and vendored dependencies (`vendor`, `third_party`, `thirdparty`, `3rdparty`), besides whatever `.gitignore` excludes.
- Big repos: when listing every file would make `map.md` longer than about 40,000 characters, its Modules section lists folders instead (as deep as fits), and Entry points shows the first 60.

## Develop

```bash
npm test
```
