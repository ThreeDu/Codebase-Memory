---
name: codemem
description: Use the project's codebase memory (codemem) instead of re-scanning the repo. Use at the start of any coding task in a repo that has a .codemem/ folder or codemem MCP tools, and whenever you need to know where something is defined, who uses it, how modules depend on each other, or what past decisions, conventions and bug fixes apply to the code you are about to change. Also use after making an architecture decision, setting a convention, or fixing a non-obvious bug, to record it.
---

# Codebase memory (codemem)

codemem keeps a map of this repo (files, imports, entry points, functions/classes and what they call) plus notes left by earlier agents. Ask it before you grep or open files: it answers in a few hundred characters what a scan answers in thousands.

## Which interface

- **MCP tools** (`get_map`, `get_context`, `find_symbol`, `read_symbol`, `add_note`, `update_note`, `remove_note`): use these when they are available. They re-index changed files before answering, so you never need to call `reindex` yourself.
- **CLI** when the tools are not available: `codemem <command>` (or `node <path-to>/Codebase-Memory/dist/src/cli.js <command>`), same names: `map`, `context`, `symbol`, `read`, `note add|edit|rm|list`.
- **Neither**: read `.codemem/map.md` directly.

## Workflow

1. **New to the repo**: `get_map` once. It lists entry points, the most depended-on modules, all notes, and every module with its imports and definitions. Don't call it again in the same task.
2. **Before working on an area**: `get_context` with the file, folder, function name, or keyword (e.g. `src/auth`, `useAuth`, `payment`). Read the notes it returns first: they are decisions and past fixes you must respect. Pass `budget` to get more when the output says it was truncated, or narrow the target.
3. **Where is X / who uses X**: `find_symbol` with `name` or `Class.method`, instead of grepping. Check every "used by" entry before changing a signature.
4. **Read code**: `read_symbol` with `name` or `Class.method` returns only that definition with its `file:start-end` range. Open the whole file only when you need more than one or two of its functions, or are about to edit it.
5. **After the task**, record what the next agent can't see from the code (one note per fact, attach `paths`):
   - `decision`: an architecture choice and why ("Auth tokens live in httpOnly cookies, not localStorage, because of XSS").
   - `convention`: a rule the code follows ("Every admin route calls verifyAdminRequest first").
   - `fix`: a non-obvious bug's cause and fix ("MODEL_DIR must be absolute; relative path broke after deploy").
   Don't record what the code or git log already says, or a summary of what you changed.
6. **Keep notes true**: a note marked `⚠ missing: <path>` points at a renamed or deleted file. Fix its `paths` with `update_note`, or `remove_note` if it no longer applies. Do the same for any note your change made wrong.

## Limits: when to fall back to grep / reading files

- Indexed: TS/JS, Python, Go, Java, Rust, C/C++, C#. Other languages, config, SQL, CSS: use normal search.
- Everything but TS/JS is read by regex: if a `read_symbol` range looks cut short or too long, open the file at that line.
- C/C++: a function can show up twice (declared in the class in the header, defined in the .cpp); the one with a body is in the source file.
- Method calls through an instance (`obj.train()`) are not tracked, so `find_symbol` may miss callers of a method. Grep for `.methodName(` before changing a method.
- Dynamic lookups (string-built imports, `getattr`, reflection) are invisible to it.
