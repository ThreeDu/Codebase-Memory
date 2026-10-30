# Codebase-Memory

Long-term memory for a codebase, so AI coding agents pick up its architecture without re-scanning everything.

- **Module map**: every TS/JS file with its resolved imports and packages, plus its entry points and most depended-on modules.
- **Notes**: architecture decisions, code conventions, and bugs that were already fixed, each attached to the files or folders it's about.
- **Incremental**: only files whose content changed get re-parsed.
- **Selective context**: an agent asks about a file, folder, or keyword and gets back only the relevant notes, plus those files with their imports and importers.

Everything lives in `.codemem/` inside the target repo (`index.json`, `notes.json`, `map.md`). Commit it so every agent and teammate shares the same memory. Agents without MCP can simply read `.codemem/map.md`.

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
| `context <file\|folder\|keyword> [--budget N]` | Focused context, cut at N chars (default 8000) |
| `note add --kind decision\|convention\|fix [--paths a,b] "<title>" ["<body>"]` | Save a note |
| `note list` | List notes |
| `mcp` | Run as an MCP server on stdio |

All commands accept `--root <dir>` (default: the current directory). After `npm link` you can call the CLI as `codemem`.

## Use from Claude Code (MCP)

```bash
claude mcp add codemem -- node E:/code_save/project/Codebase-Memory/dist/src/cli.js mcp --root .
```

Tools: `reindex`, `get_map`, `get_context`, `add_note`. A good line for the target repo's `CLAUDE.md`/`AGENTS.md`:

> Before working on an area, call `get_context` for it. After changes call `reindex`; record decisions, conventions, and non-obvious bug fixes with `add_note`.

## Limits (v1)

- Parses TS/JS only (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), import-level, not symbols.
- tsconfig `paths` aliases are listed as packages, not resolved.
- No file watcher. Call `reindex` (cheap) after edits.

## Develop

```bash
npm test
```
