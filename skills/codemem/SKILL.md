---
name: codemem
description: Use the project's codebase memory (codemem) instead of re-scanning the repo. Use at the start of any coding task in a repo that has a .codemem/ folder or codemem MCP tools, and whenever you need to know where something is defined, who uses it, what a change would affect, how modules depend on each other, which code is unused, or what past decisions, conventions and bug fixes apply to the code you are about to change. Also use after making an architecture decision, setting a convention, or fixing a non-obvious bug, to record it.
---

# Codebase memory (codemem)

codemem keeps a map of this repo (files, imports, entry points, functions/classes and what they call) plus notes left by earlier agents. Ask it before you grep or open files: it answers in a few hundred characters what a scan answers in thousands.

## Which interface

- **MCP tools** (`get_map`, `get_context`, `find_symbol`, `search_symbols`, `read_symbol`, `affected`, `add_note`, `update_note`, `remove_note`): use these when available. They re-index changed files before answering, so never call `reindex` yourself, even right after editing.
- **CLI** when the tools aren't there: `codemem <command>`, or `npx -y @threedu/codebase-memory <command>` if it isn't installed. Same names: `map`, `context`, `symbol`, `search`, `read`, `affected`, `note add|edit|rm|list`.
- **Neither**: read `.codemem/map.md` directly.
- **No `.codemem/` and no tools**: work normally. If the user wants it set up, follow the Installation and MCP sections of the package's `docs/USAGE.md` (github.com/ThreeDu/Codebase-Memory).

## Workflow

1. **New to the repo**: `get_map` once. It lists entry points, the most depended-on modules, all notes, and the modules with their imports. On a big repo the modules are grouped by folder; ask `get_context` for a folder to see its files. Don't call `get_map` again in the same task.
2. **Before working on an area**: `get_context` with a file or folder path (`src/auth`), or an exact function/class name. Read the notes it returns first, both the manual ones and the `WHY:` / `NOTE:` / `HACK:` comments listed under each file: they are decisions and past fixes you must respect. A keyword there only matches file paths and note text; to find code for a concept, use `search_symbols`.
3. **Find code**:
   - Exact name known: `find_symbol` (`name` or `Class.method`) for where it's defined and every caller.
   - Rough idea only ("the payment webhook handler"): `search_symbols` with a few words, then `find_symbol` / `read_symbol` on the best hit. Code ranks before tests; add "test" to the query to find tests. Rephrase with a synonym if nothing fits (`delete` / `remove`, `user` / `account`).
4. **Read code**: `read_symbol` returns just that definition with its `file:start-end` range, who uses it, a warning when no test does, and the comments explaining it. Open the whole file only to edit it or when you need several of its functions.
5. **Before changing a signature, renaming, or deleting**: list what breaks. `read_symbol` / `find_symbol` give the direct callers ("used by ... in: f, g"); `affected` with the files you'll touch gives everything that depends on them through several hops, and the tests to run afterwards. Update every caller, or say why not; if `read_symbol` warned that no test uses it, say so or add one.
6. **Unused code**: an entry point in `get_map` that is a TS/JS/Python file nothing imports, and that isn't a script, test, config or a package's public entry, is a likely leftover. Confirm with a text search for its name before calling it dead.
7. **After the task**, record what the next agent can't see from the code: one note per fact, with `paths`.
   - `decision`: an architecture choice and why ("Auth tokens live in httpOnly cookies, not localStorage, because of XSS").
   - `convention`: a rule the code follows ("Every admin route calls verifyAdminRequest first").
   - `fix`: a non-obvious bug's cause and fix ("MODEL_DIR must be absolute; relative path broke after deploy").
   First check the notes `get_context` showed: if one already covers it, `update_note` instead of adding a near-duplicate. Don't record what the code or git log already says, or a summary of your change.
   A reason that belongs to one function is better as a comment right above it, `// WHY: ...` (or `NOTE:`, `HACK:`, `IMPORTANT:`, `RATIONALE:`, `DECISION:`, uppercase): codemem attaches it to that function. Never put secrets in it.
   After editing, `affected` on the files you changed tells you which tests to run.
8. **Keep notes true**: a note marked `⚠ missing: <path>` points at a renamed or deleted file. Fix its `paths` with `update_note`, or `remove_note` if it no longer applies. Do the same for any note your change made wrong.

## When results look wrong or empty

- Everything comes back empty, or `get_map` says 0 source files: the project is in a folder git ignores, or in a language codemem doesn't read. Fall back to normal search.
- Not indexed at all: build output (`dist`, `build`, `target`, `obj`), vendored code (`vendor`, `third_party`, `thirdparty`, `3rdparty`) and anything `.gitignore` excludes. Search those directly. A file marked "over 5 MB, not read" is listed but its contents aren't indexed.
- `affected` finds few files in a monorepo: packages imported by name (`shared/flags` through workspaces or a bundler alias) aren't linked yet; only relative imports and tsconfig/jsconfig aliases are.
- Indexed: TS/JS, Python, Go, Java, Rust, C/C++, C#. Config, SQL, CSS, templates and other languages: normal search.
- Everything but TS/JS is read by regex: if a `read_symbol` range looks cut short or too long, open the file at that line.
- C/C++: a function can show up twice (declared in the header's class, defined in the .cpp); the one with a body is in the source file.
- Method calls through an instance (`obj.train()`) aren't tracked, so `find_symbol` can miss a method's callers. Grep for `.methodName(` before changing a method.
- Dynamic lookups (string-built imports, `getattr`, reflection, dependency injection by name) are invisible to it.
- Entry points: Go, Java, C/C++ and C# files count only with a `main`; for them "nothing imports it" means nothing.
