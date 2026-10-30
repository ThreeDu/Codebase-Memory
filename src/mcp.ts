import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { context } from "./context.js";
import { renderMap, update, writeMap } from "./index.js";
import { addNote, KINDS } from "./notes.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export async function serve(root: string): Promise<void> {
  const server = new McpServer({ name: "codebase-memory", version: "0.1.0" });

  server.registerTool(
    "reindex",
    { description: "Update the codebase memory after files changed. Incremental: only changed files are re-parsed." },
    async () => {
      const { index, parsed } = update(root);
      return text(`Indexed ${Object.keys(index.files).length} files (${parsed} re-parsed).`);
    },
  );

  server.registerTool(
    "get_map",
    { description: "Project overview: entry points, most depended-on modules, notes, and every module with its imports." },
    async () => text(renderMap(root)),
  );

  server.registerTool(
    "get_context",
    {
      description:
        "Focused context for a task: notes (decisions, conventions, past fixes) and files with their imports/importers, for a file path, folder, or keyword.",
      inputSchema: {
        target: z.string().describe("File path, folder, or keyword, e.g. 'src/auth' or 'payment'"),
        budget: z.number().int().positive().optional().describe("Max characters to return (default 8000)"),
      },
    },
    async ({ target, budget }) => text(context(root, target, budget)),
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

  await server.connect(new StdioServerTransport());
}
