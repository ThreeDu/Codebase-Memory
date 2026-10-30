# Codebase-Memory

Long-term memory for a codebase, so AI coding agents pick up its architecture without re-scanning everything.

- **Module map**: every TS/JS and Python file with its resolved imports and packages, plus its entry points and most depended-on modules.
- **Symbols**: the functions, classes, and methods each file defines, which names it takes from which file, and which of those each function calls, so you can ask where `ChurnPredictor` is defined and which functions use it.
- **Notes**: architecture decisions, code conventions, and bugs that were already fixed, each attached to the files or folders it's about.
- **Incremental**: only files whose content changed get re-parsed.
- **Selective context**: an agent asks about a file, folder, or keyword and gets back only the relevant notes, plus those files with their imports and importers.

Everything lives in `.codemem/` inside the target repo (`index.json`, `notes.json`, `map.md`). Commit it so every agent and teammate shares the same memory. Agents without MCP can simply read `.codemem/map.md`.

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
| `note add --kind decision\|convention\|fix [--paths a,b] "<title>" ["<body>"]` | Save a note |
| `note list` | List notes |
| `graph [--no-open]` | Re-index, write `.codemem/graph.html`, and open it in the browser |
| `mcp` | Run as an MCP server on stdio |

All commands accept `--root <dir>` (default: the current directory). After `npm link` you can call the CLI as `codemem`.

## Graph view

`codemem graph` opens an interactive map of the whole codebase: folders are boxes, files are dots (bigger = more importers, orange ring = entry point), arrows are imports. Click a file to highlight what it imports and what imports it (highlighted arrows show the imported names), with its functions/classes, what each one calls, and its notes in the side panel; click a folder for its files; type a file or function name in the search box and press Enter to jump to it. The page is a single file with the data embedded (it loads Cytoscape and its fcose layout from cdnjs/jsDelivr, so it needs internet). It's regenerated on every run, so you may want `.codemem/graph.html` in the target repo's `.gitignore`.

## Use from Claude Code (MCP)

```bash
claude mcp add codemem -- node E:/code_save/project/Codebase-Memory/dist/src/cli.js mcp --root .
```

Tools: `reindex`, `get_map`, `get_context`, `find_symbol`, `add_note`. A good line for the target repo's `CLAUDE.md`/`AGENTS.md`:

> Before working on an area, call `get_context` for it. After changes call `reindex`; record decisions, conventions, and non-obvious bug fixes with `add_note`.

## Limits (v1)

- Parses TS/JS (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, ES modules and CommonJS) and Python (`.py`).
- Symbols: top-level functions, classes, methods, exported constants (TS/JS) and module CONSTANTS (Python). Calls are matched by name, so a method called through an instance (`obj.train()`) is not tracked; a default import or `module.exports = expr` is matched by its local name / the file name.
- Python: imports and symbols are found by regex, and absolute imports are looked up from the importing file's folder up to the repo root (so a service folder like `ml-service/` works as its own source root), then `src/`.
- tsconfig `paths` aliases are listed as packages, not resolved.
- No file watcher. Call `reindex` (cheap) after edits.

## Develop

```bash
npm test
```
