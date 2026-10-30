import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STORE } from "./index.js";

export const KINDS = ["decision", "convention", "fix"] as const;
export type NoteKind = (typeof KINDS)[number];

export interface Note {
  id: number;
  kind: NoteKind;
  title: string;
  body: string;
  paths: string[]; // repo-relative files or folders the note is about
  date: string;
}

const notesPath = (root: string) => join(root, STORE, "notes.json");

export function loadNotes(root: string): Note[] {
  const p = notesPath(root);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

export function addNote(root: string, input: { kind: string; title: string; body?: string; paths?: string[] }): Note {
  if (!KINDS.includes(input.kind as NoteKind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  if (!input.title?.trim()) throw new Error("title is required");
  const notes = loadNotes(root);
  const note: Note = {
    id: Math.max(0, ...notes.map((n) => n.id)) + 1,
    kind: input.kind as NoteKind,
    title: input.title.trim(),
    body: input.body?.trim() ?? "",
    paths: (input.paths ?? []).map(normalizePath).filter(Boolean),
    date: new Date().toISOString().slice(0, 10),
  };
  mkdirSync(join(root, STORE), { recursive: true });
  writeFileSync(notesPath(root), JSON.stringify([...notes, note], null, 1));
  return note;
}

export const normalizePath = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
