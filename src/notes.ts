import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLock, writeAtomic } from "./files.js";
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
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    // never start over silently: the next save would wipe every note
    throw new Error(`${STORE}/notes.json is not valid JSON (${(e as Error).message}); fix it or restore it from git`);
  }
}

type NoteInput = { kind: string; title: string; body?: string; paths?: string[] };

const save = (root: string, notes: Note[]) => writeAtomic(notesPath(root), JSON.stringify(notes, null, 1));
// read, change and save under one lock: two agents adding a note at once both keep theirs, with different ids
const locked = <T>(root: string, fn: () => T) => withLock(notesPath(root), fn);

function build(id: number, input: NoteInput): Note {
  if (!KINDS.includes(input.kind as NoteKind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  if (!input.title?.trim()) throw new Error("title is required");
  return {
    id,
    kind: input.kind as NoteKind,
    title: input.title.trim(),
    body: input.body?.trim() ?? "",
    paths: (input.paths ?? []).map(normalizePath).filter(Boolean),
    date: new Date().toISOString().slice(0, 10),
  };
}

export function addNote(root: string, input: NoteInput): Note {
  return locked(root, () => {
    const notes = loadNotes(root);
    const note = build(Math.max(0, ...notes.map((n) => n.id)) + 1, input);
    save(root, [...notes, note]);
    return note;
  });
}

/** Change some fields of a note; the others are kept. The date becomes today's. */
export function updateNote(root: string, id: number, change: Partial<NoteInput>): Note {
  return locked(root, () => {
    const notes = loadNotes(root);
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) throw new Error(`no note #${id}`);
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
    notes[i] = build(id, { ...notes[i], ...defined });
    save(root, notes);
    return notes[i];
  });
}

export function removeNote(root: string, id: number): void {
  locked(root, () => {
    const notes = loadNotes(root);
    if (!notes.some((n) => n.id === id)) throw new Error(`no note #${id}`);
    save(root, notes.filter((n) => n.id !== id));
  });
}

/** Paths the note is about that no longer exist (renamed or deleted), so the note may be out of date. */
const missingPaths = (root: string, note: Note) => note.paths.filter((p) => !existsSync(join(root, p)));

/** " ⚠ missing: a, b" to append wherever a note is shown, or "" when all its paths exist. */
export const staleMark = (root: string, note: Note) => {
  const gone = missingPaths(root, note);
  return gone.length ? ` ⚠ missing: ${gone.join(", ")}` : "";
};

export const normalizePath = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
