import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { context, findSymbol, readSymbol, searchSymbols } from "./context.js";
import { renderMap, update, writeMap } from "./index.js";
import { addNote, KINDS, removeNote, updateNote } from "./notes.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export async function serve(root: string): Promise<void> {
  // dist/src/mcp.js -> the package's own package.json, so clients see the installed version
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const server = new McpServer({ name: "codebase-memory", version });

  server.registerTool(
    "reindex",
    {
      description:
        "Re-index the codebase memory now. Rarely needed: the other tools re-index changed files before answering.",
    },
    async () => {
      const { index, parsed } = update(root);
      return text(`Indexed ${Object.keys(index.files).length} files (${parsed} re-parsed).`);
    },
  );

  server.registerTool(
    "get_map",
    { description: "Project overview: entry points, most depended-on modules, notes, and every module with its imports." },
    async () => text(renderMap(root, update(root).index)),
  );

  server.registerTool(
    "get_context",
    {
      description:
        "Focused context for a task: notes (decisions, conventions, past fixes) and files with their functions/classes, what each calls, and imports/importers with the names used. Target is a file path, folder, symbol name, or keyword.",
      inputSchema: {
        target: z.string().describe("File path, folder, symbol, or keyword, e.g. 'src/auth', 'useAuth' or 'payment'"),
        budget: z.number().int().positive().optional().describe("Max characters to return (default 8000)"),
      },
    },
    async ({ target, budget }) => text(context(root, target, budget)),
  );

  server.registerTool(
    "find_symbol",
    {
      description: "Where a function or class is defined and which files and functions use it. Accepts 'name' or 'Class.method'.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => text(findSymbol(root, name)),
  );

  server.registerTool(
    "search_symbols",
    {
      description:
        "Find functions, classes and methods when you don't know the exact name: a rough name or a few words, e.g. 'payment webhook', 'parseConfig', 'user repo'. Returns the best matches with file:line; follow up with find_symbol or read_symbol.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, limit }) => text(searchSymbols(root, query, limit)),
  );

  server.registerTool(
    "read_symbol",
    {
      description:
        "Source code of one function, class or method, with its file and line range. Read this instead of the whole file. Accepts 'name' or 'Class.method'.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => text(readSymbol(root, name)),
  );

  server.registerTool(
    "add_note",
    {
      description:
        "Remember something for future agents: an architecture decision, a code convention, or a bug fix (cause + fix). Attach the paths it applies to.",
      inputSchema: {
        kind: z.enum(KINDS),
        title: z.string().min(1),
        body: z.string().optional(),
        paths: z.array(z.string()).optional().describe("Files or folders the note is about"),
      },
    },
    async (input) => {
      const note = addNote(root, input);
      writeMap(root);
      return text(`Saved note #${note.id}.`);
    },
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Correct an existing note (its #id is shown in get_map and get_context). Only the fields you pass change. Use it when a note marked ⚠ missing points at renamed files, or the decision changed.",
      inputSchema: {
        id: z.number().int(),
        kind: z.enum(KINDS).optional(),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        paths: z.array(z.string()).optional(),
      },
    },
    async ({ id, ...change }) => {
      const note = updateNote(root, id, change);
      writeMap(root);
      return text(`Updated note #${note.id}.`);
    },
  );

  server.registerTool(
    "remove_note",
    {
      description: "Delete a note that is no longer true (e.g. the code it describes was removed).",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      removeNote(root, id);
      writeMap(root);
      return text(`Removed note #${id}.`);
    },
  );

  await server.connect(new StdioServerTransport());
}
