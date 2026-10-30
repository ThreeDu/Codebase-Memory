# Codebase Memory: Installation and Usage

Codebase Memory builds a long-term memory of a codebase: the module map, entry points, the functions and classes each file defines, how files and functions use each other, and notes about decisions, conventions, and bugs that were already fixed. AI coding agents query it (over MCP or the CLI) instead of re-reading the whole repository each session.

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Using it from AI agents (MCP)](#using-it-from-ai-agents-mcp)
- [What gets stored](#what-gets-stored)
- [Recommended workflow](#recommended-workflow)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Requirements

- **Node.js 20 or newer** (`node -v` to check)
- **npm** (comes with Node.js)
- **git** (optional): if the project you index is a git repository, `.gitignore` is respected automatically
- **Internet access** only for the graph view, which loads its drawing library from a CDN

Supported source files: TypeScript / JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, both ES modules and CommonJS) and Python (`.py`).

## Installation

1. Get the code and install dependencies:

   ```bash
   git clone <this-repo-url> Codebase-Memory
   cd Codebase-Memory
   npm install
   ```

2. Build it:

   ```bash
   npm run build
   ```

3. Make the `codemem` command available everywhere (optional, recommended):

   ```bash
   npm link
   ```

4. Check that it works. Running it with no command prints the usage:

   ```bash
   codemem
   ```

   ```
   codemem <command> [--root <dir>]

     index [dir]                          update the memory (incremental)
     map                                  print the project map
     context <file|folder|symbol|keyword> [--budget N]
     symbol <name|Class.method>           where it is defined and who uses it
     read <name|Class.method>             print its source code
     note add --kind <decision|convention|fix> [--paths a,b] "<title>" ["<body>"]
     note edit <id> [--kind K] [--title T] [--body B] [--paths a,b]
     note rm <id>
     note list                            ⚠ marks notes whose paths no longer exist
     graph [--no-open]                    write .codemem/graph.html and open it
     watch                                keep map.md and graph.html updated as code changes
     mcp                                  run the MCP server on stdio
   ```

Without `npm link`, replace `codemem` in every example with `node <path-to>/Codebase-Memory/dist/src/cli.js`.

To run the test suite:

```bash
npm test
```

## Quick start

Go to the project you want to remember, index it, and look around:

```bash
cd path/to/your-project
codemem index
codemem map
codemem graph
```

`codemem index` creates a `.codemem/` folder in that project. Run it again whenever code changes. Only files whose content changed are re-parsed, so it is fast.

## Command reference

Every command works on the current directory. Add `--root <dir>` to point it at another project, for example `codemem map --root ../shop`.

### `index [dir]`: create or update the memory

```bash
codemem index
codemem index path/to/project
```

```
Indexed 173 files (12 re-parsed) into /path/to/project/.codemem
```

Scans all supported source files, records each file's imports, the names it imports, its functions/classes/methods, and what each function calls. A file is only re-parsed when its content changed. It also regenerates `.codemem/map.md`.

### `map`: print the project overview

```bash
codemem map
```

```markdown
# Codebase map

## Entry points
- `src/main.ts`

## Most depended-on
- `src/context/AuthContext.js` (41 importers)

## Notes
- [decision] Barrel exports (src/lib)

## Modules

### src/
- `src/main.ts` → src/lib/index.ts, pkg:chalk
  - defines: run, class App
```

- **Entry points**: files listed in `package.json` (`main`, `bin`, `exports`) plus source files nothing imports (tests and `__init__.py` excluded). An unexpected entry point is often dead code.
- **Most depended-on**: changing these affects the most files.
- **Modules**: every file with what it imports (`pkg:` = external package) and what it defines.

The same text is saved in `.codemem/map.md`, so agents and people can read it without running anything.

### `context <target> [--budget N]`: focused context for a task

`target` can be a file, a folder, a function/class name, or a keyword.

```bash
codemem context src/main.ts
codemem context server/controllers
codemem context useAuth
codemem context payment --budget 4000
```

```markdown
# Context: src/main.ts

## Files (1)
- `src/main.ts`
  - imports: src/lib/index.ts (greet)
  - packages: chalk
  - imported by: src/main.test.ts
  - defines:
    - function `run` :4 (exported) → greet (src/lib/greet.ts)
    - class `App` :8
      - method `start` :9 → run
```

It returns:

- **Notes**: any note attached to the matched files or folders, or mentioning the keyword
- **Symbols**: if the target is a function/class name, where it is defined and who uses it
- **Files**, each with:
  - imported files and the names taken from each
  - external packages
  - the files that import it, with the names they take
  - each function/class/method it defines, with its line number and what it calls (calls into another file show that file)

`--budget` caps the output length in characters (default 8000). If the output is cut, narrow the target.

### `symbol <name>`: where is it defined, who uses it

```bash
codemem symbol greet
codemem symbol ChurnPredictor
codemem symbol ChurnPredictor.train
```

```markdown
# Symbol: greet

- function `greet` defined at `src/lib/greet.ts:2`
  - used by `src/lib/index.ts`
  - used by `src/main.ts` in: run
```

For a class it also lists its methods. `used by ... in: run` names the functions that use it. Re-exports through barrel files (`index.ts`, `export *`) are followed, so you get the real definition, not the barrel.

### `read <name>`: print just one function's code

```bash
codemem read greet
codemem read ChurnPredictor.train
```

````markdown
## `src/lib/greet.ts:2-4`

```
export function greet(name: string) {
  return `Hello, ${name}`;
}
```
````

Prints only that function, class, or method with its file and line range, so you (or an agent) don't have to open the whole file. If several files define the same name, each one is printed.

### `note add`: remember a decision, convention, or fix

```bash
codemem note add --kind decision --paths src/lib "Barrel exports" "Import from src/lib, never from src/lib/greet directly"
codemem note add --kind convention --paths server/routes "Auth check in every admin route" "Call verifyAdminRequest first"
codemem note add --kind fix --paths ml-service/models "Model file missing after deploy" "MODEL_DIR must be absolute; fixed in config.py"
```

```
Saved note #1.
```

| Option | Meaning |
|---|---|
| `--kind` | Required. One of `decision`, `convention`, `fix` |
| `--paths` | Optional. Comma-separated files or folders the note is about, no spaces: `src/auth,server/routes` |
| first quoted text | Required. Short title |
| second quoted text | Optional. Details: the why, the cause and fix |

Notes attached to a folder appear in `context` for every file inside it.

### `note list`: show all notes

```bash
codemem note list
```

```
#1 [decision] Barrel exports (src/lib)
#2 [fix] Orphan kept on purpose (src/orphan.ts) ⚠ missing: src/orphan.ts
```

`⚠ missing` means a file or folder the note is about was renamed or deleted, so the note may be out of date. The same mark shows in `map`, `context`, and the MCP tools. Fix the note or remove it:

### `note edit` / `note rm`: correct or delete a note

```bash
codemem note edit 2 --paths src/main.ts --body "Moved into main.ts"
codemem note edit 1 --kind convention
codemem note rm 2
```

`edit` changes only the options you pass (`--kind`, `--title`, `--body`, `--paths`) and sets the note's date to today. The note's number is shown by `note list`, `map`, and `context`.

### `graph [--no-open]`: interactive picture of the codebase

```bash
codemem graph
codemem graph --no-open
```

Re-indexes, writes `.codemem/graph.html`, and opens it in your browser (`--no-open` only writes the file).

In the graph:

| What you see | Meaning |
|---|---|
| Box | A folder (nested like the folder tree) |
| Dot | A file. Bigger = imported by more files. Color = top-level folder |
| Orange ring | Entry point |
| Arrow | "imports". Highlighted arrows are labelled with the imported names |

| What you do | What happens |
|---|---|
| Click a file | Its imports and importers are highlighted. The side panel lists its functions/classes, what each calls, its imports and importers with names, and its notes |
| Click a name in the side panel | Jumps to the file that defines it |
| Click a folder box | Lists the folder's files and notes |
| Type in the search box + Enter | Jumps to a file by path, or to the file that defines a function/class by name |
| Click empty space | Clears the highlight |
| Scroll / drag | Zoom / pan |

### `watch`: keep the map and graph up to date

```bash
codemem watch
```

```
9:34:24 PM updated map and graph
Watching E:\path\to\your-project (Ctrl+C to stop)
9:34:25 PM updated map and graph
```

Leave it running in a terminal while you code. Every time a TS/JS or Python file is saved, created, or deleted, it re-indexes and rewrites `.codemem/map.md` and `.codemem/graph.html` (several saves within 0.3 s count as one). The open graph page doesn't reload itself: refresh the browser tab to see the change.

### `mcp`: run as an MCP server

```bash
codemem mcp
```

You normally don't run this yourself. Your AI tool starts it; see the next section.

## Using it from AI agents (MCP)

### Claude Code

Register it once for all your projects:

```bash
claude mcp add -s user codemem -- node /path/to/Codebase-Memory/dist/src/cli.js mcp --root .
```

Replace the path with where you installed Codebase Memory. `--root .` means "the project Claude Code is opened in". To register it for one project only, run the command inside that project without `-s user`.

### Other MCP clients (Cursor, Claude Desktop, ...)

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "codemem": {
      "command": "node",
      "args": ["/path/to/Codebase-Memory/dist/src/cli.js", "mcp", "--root", "/path/to/your-project"]
    }
  }
}
```

Use an absolute `--root` unless you know the client starts servers inside the project folder.

### Tools the agent gets

| Tool | Input | Returns |
|---|---|---|
| `reindex` | none | Updates the memory; reports how many files were re-parsed. Rarely needed: the tools below re-index changed files before answering |
| `get_map` | none | The project overview (same as `codemem map`) |
| `get_context` | `target`, optional `budget` | Same as `codemem context` |
| `find_symbol` | `name` (`name` or `Class.method`) | Same as `codemem symbol` |
| `read_symbol` | `name` (`name` or `Class.method`) | Same as `codemem read` |
| `add_note` | `kind`, `title`, optional `body`, `paths` | Saves a note |
| `update_note` | `id`, optional `kind`, `title`, `body`, `paths` | Same as `codemem note edit` |
| `remove_note` | `id` | Same as `codemem note rm` |

### Tell the agent to use it

Add this to the project's `CLAUDE.md` or `AGENTS.md`:

```markdown
## Codebase memory
- Before working on an area, call `get_context` for the file, folder, or function you are about to change.
- To find where something is defined or who uses it, call `find_symbol` instead of searching.
- To read a function, call `read_symbol` instead of opening the whole file.
- When you make an architecture decision, establish a convention, or fix a non-obvious bug, record it with `add_note` (attach the paths).
- If a note is marked `⚠ missing` or no longer true, fix it with `update_note` or delete it with `remove_note`.
```

Agents that can't use MCP can read `.codemem/map.md` directly.

## What gets stored

Everything is inside `.codemem/` in the indexed project:

| File | Content | Commit it? |
|---|---|---|
| `index.json` | Files, hashes, imports, symbols, calls | Yes, so others skip the first full scan |
| `notes.json` | Your notes | **Yes**: this is the knowledge you can't regenerate |
| `map.md` | Generated overview | Yes, so agents without MCP can read it |
| `graph.html` | Generated graph page | Optional: it's large and regenerated on every `graph` run; add `.codemem/graph.html` to `.gitignore` if you prefer |

All files are plain JSON/Markdown and safe to delete. `codemem index` rebuilds everything except `notes.json`.

## Recommended workflow

1. **First time in a project**: `codemem index`, then `codemem graph` to get the big picture.
2. **Before changing something**: `codemem context <file or folder>`, or `codemem symbol <name>` to see who will be affected.
3. **After changing code**: nothing to do; `context`, `symbol`, `read` and the MCP tools re-index changed files first. Run `codemem index` before committing so `.codemem/` is current.
4. **When you learn something worth keeping**: `codemem note add ...`.
5. **Commit `.codemem/`** with your code so teammates and agents share the same memory.

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| `No index yet. Run codemem index...` | The project hasn't been indexed. Run `codemem index` in it (or with `--root`) |
| `codemem: command not found` | `npm link` wasn't run, or the npm global folder isn't on your PATH. Use `node <path>/dist/src/cli.js` instead |
| A positional argument is ignored | Every `--flag` takes the next word as its value. Put `--no-open` last: `codemem graph --root x --no-open` |
| `codemem: kind must be one of: decision, convention, fix` | `--kind` is missing or misspelled in `note add` |
| Results look stale | Run `codemem index` again; nothing updates on its own |
| A function shows no callers you expected | Calls are matched by name: a method called through an instance (`obj.train()`) is not tracked, and a default import is matched by the name used when importing it |
| Import with a tsconfig `paths` alias (`@/components/...`) shows as a package | Aliases are not resolved yet |
| Python file imports show as packages | Absolute imports are looked up from the importing file's folder up to the project root, then `src/`. Other source roots aren't searched |
| Graph page is blank | It needs internet to load Cytoscape from cdnjs/jsDelivr |
| Graph is slow | Expected above roughly 2000 files |
| Build fails after upgrading dependencies | Keep `typescript` on 5.x: TypeScript 7 removed the parser API this tool uses |

## Uninstall

```bash
npm uninstall -g codebase-memory
claude mcp remove codemem
```

Then delete the `Codebase-Memory` folder, and `.codemem/` in any project you no longer want indexed.
