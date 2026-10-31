import ts from "typescript";

export interface Sym {
  name: string;
  kind: "function" | "class" | "method" | "const" | "type";
  line: number;
  end?: number; // last line of the definition
  exported?: boolean;
  parent?: string; // class name, for methods
  calls?: string[]; // imported names (as exported by their module) and same-file top-level names used in the body
}
export interface Parsed {
  specs: string[]; // raw import specifiers
  names: Record<string, string[]>; // spec -> names imported from it ("*" for a whole-module import)
  symbols: Sym[];
  main?: boolean; // runs on its own (Python `if __name__ == "__main__":`), even if other files import it
  namespaces?: string[]; // C#: namespaces this file declares
  refs?: string[]; // C#: every name the file mentions, including top-level statements outside any class
}

const pushUnique = (m: Record<string, string[]>, k: string, v: string) => {
  if (!(m[k] ??= []).includes(v)) m[k].push(v);
};

export function parseTs(file: string, src: string): Parsed {
  // preProcessFile also catches require() and dynamic import(); the AST walk below adds the imported names
  const specs = [...new Set(ts.preProcessFile(src, true, true).importedFiles.map((i) => i.fileName))];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const names: Record<string, string[]> = {};
  const alias = new Map<string, string>(); // local name -> name exported by the source module
  const namespaces = new Set<string>(); // `import * as x`: x.foo uses foo
  const symbols: Sym[] = [];
  const bodies: [Sym, ts.Node][] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const at = (n: ts.Node) => ({ line: line(n), end: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 });
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isFn = (n?: ts.Node) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  const requireOf = (n?: ts.Node) =>
    n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && ts.isStringLiteral(n.arguments[0] ?? n)
      ? (n.arguments[0] as ts.StringLiteral).text
      : undefined;

  // CommonJS exports: `module.exports = { a, b }` / `module.exports = X` mark existing names exported;
  // `exports.x = ...` / `module.exports.x = ...` define x
  const cjsExported = new Set<string>();
  // `module.exports = mongoose.model(...)` / `export default connect(X)` has no name of its own; name it after the file,
  // which is how importers usually name it (`const Product = require("./models/Product")`)
  const anonymousDefault = (st: ts.Node, value: ts.Expression) => {
    if (ts.isIdentifier(value)) return cjsExported.add(value.text);
    const s: Sym = {
      name: file.split("/").pop()!.replace(/\.[^.]+$/, ""),
      kind: ts.isClassExpression(value) ? "class" : isFn(value) ? "function" : "const",
      ...at(st),
      exported: true,
    };
    symbols.push(s);
    bodies.push([s, value]);
  };
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) anonymousDefault(st, st.expression);
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
    const { left, right, operatorToken } = st.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const target = left.getText(sf);
    if (target === "module.exports") {
      if (ts.isObjectLiteralExpression(right))
        for (const p of right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) cjsExported.add(p.name.text);
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) cjsExported.add(p.initializer.text);
        }
      else anonymousDefault(st, right);
    } else if (/^(module\.)?exports\.\w+$/.test(target) && ts.isPropertyAccessExpression(left)) {
      if (ts.isIdentifier(right)) cjsExported.add(right.text);
      else {
        const s: Sym = { name: left.name.text, kind: isFn(right) ? "function" : "const", ...at(st), exported: true };
        symbols.push(s);
        bodies.push([s, right]);
      }
    }
  }

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      // shortcut: a default import is matched by its local name, which is usually the exported function/class name
      if (clause?.name) {
        pushUnique(names, spec, clause.name.text);
        alias.set(clause.name.text, clause.name.text);
      }
      const b = clause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) {
        pushUnique(names, spec, "*");
        namespaces.add(b.name.text);
      } else if (b)
        for (const e of b.elements) {
          const orig = (e.propertyName ?? e.name).text;
          pushUnique(names, spec, orig);
          alias.set(e.name.text, orig);
        }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (st.exportClause && ts.isNamedExports(st.exportClause))
        for (const e of st.exportClause.elements) pushUnique(names, spec, (e.propertyName ?? e.name).text);
      else pushUnique(names, spec, "*");
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      const s: Sym = { name: st.name.text, kind: "function", ...at(st), exported: exported(st) || cjsExported.has(st.name.text) };
      symbols.push(s);
      bodies.push([s, st]);
    } else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text;
      symbols.push({ name: cls, kind: "class", ...at(st), exported: exported(st) || cjsExported.has(cls) });
      for (const m of st.members) {
        const isMethod =
          ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || (ts.isPropertyDeclaration(m) && isFn(m.initializer));
        if (!isMethod) continue;
        const s: Sym = { name: m.name ? m.name.getText(sf) : "constructor", kind: "method", ...at(m), parent: cls };
        symbols.push(s);
        bodies.push([s, m]);
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const req = requireOf(d.initializer);
        if (req) {
          // `const X = require("m")`: X.foo uses foo, and X itself is matched by name like a default import
          if (ts.isIdentifier(d.name)) {
            pushUnique(names, req, d.name.text);
            alias.set(d.name.text, d.name.text);
            namespaces.add(d.name.text);
          } else if (ts.isObjectBindingPattern(d.name))
            for (const el of d.name.elements) {
              if (!ts.isIdentifier(el.name)) continue;
              const orig = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
              pushUnique(names, req, orig);
              alias.set(el.name.text, orig);
            }
          continue;
        }
        if (!ts.isIdentifier(d.name)) continue;
        const fn = isFn(d.initializer);
        const isExported = exported(st) || cjsExported.has(d.name.text);
        if (!fn && !isExported) continue; // plain local constants are noise
        const s: Sym = { name: d.name.text, kind: fn ? "function" : "const", ...at(d), exported: isExported };
        symbols.push(s);
        if (d.initializer) bodies.push([s, d.initializer]);
      }
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      symbols.push({ name: st.name.text, kind: "type", ...at(st), exported: exported(st) });
    }
  }

  const local = new Set(symbols.filter((s) => !s.parent).map((s) => s.name));
  for (const [s, node] of bodies) {
    const calls = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        // x.foo: only "foo" of a namespace import counts; a property name is never an imported binding.
        // A same-file name can't be what x.foo means (jwt.verify inside our own verify)
        if (ts.isIdentifier(n.expression) && namespaces.has(n.expression.text) && !local.has(n.name.text)) calls.add(n.name.text);
        return visit(n.expression);
      }
      if (ts.isIdentifier(n)) {
        const orig = alias.get(n.text);
        if (orig) calls.add(orig);
        else if (local.has(n.text) && n.text !== s.name) calls.add(n.text);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    if (calls.size) s.calls = [...calls].sort();
  }
  return { specs, names, symbols };
}

/** Python: "a.b" for `import a.b`; "M" and "M.name" for `from M import name` (name may be a submodule). */
// shortcut: regex scan, so code-looking lines inside docstrings count too; switch to a real parser if that bites.
export function parsePy(src: string): Parsed {
  const specs = new Set<string>();
  const names: Record<string, string[]> = {};
  const alias = new Map<string, string>();
  const namespaces = new Set<string>(); // `import config` / `import config as c`: c.X uses X
  const list = (s: string) =>
    s
      .replace(/[()\\]/g, "")
      .split(",")
      .map((n) => n.replace(/#.*/, "").trim().split(/\s+as\s+/))
      .filter(([n]) => n);
  for (const [, l] of src.matchAll(/^[ \t]*import[ \t]+(.+)$/gm))
    for (const [mod, as] of list(l)) {
      specs.add(mod);
      pushUnique(names, mod, "*");
      if (as || !mod.includes(".")) namespaces.add(as ?? mod);
    }
  for (const [, mod, l] of src.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|.+)$/gm)) {
    specs.add(mod);
    for (const [n, as] of list(l)) {
      pushUnique(names, mod, n);
      if (n === "*") continue;
      specs.add(mod.endsWith(".") ? mod + n : `${mod}.${n}`);
      alias.set(as ?? n, n);
    }
  }

  const lines = src.split(/\r?\n/);
  const symbols: Sym[] = [];
  const bodies: [Sym, number, number][] = []; // symbol, def line index, def indent
  let cls: { name: string; indent: number; inner?: number } | undefined;
  lines.forEach((l, i) => {
    const indent = l.search(/\S/);
    if (indent < 0 || l[indent] === "#") return;
    if (cls && indent <= cls.indent) cls = undefined;
    const def = l.match(/^(\s*)(?:async\s+)?(def|class)\s+(\w+)/);
    if (def && indent === 0) {
      const s: Sym = { name: def[3], kind: def[2] === "class" ? "class" : "function", line: i + 1 };
      symbols.push(s);
      if (def[2] === "class") cls = { name: def[3], indent: 0 };
      bodies.push([s, i, 0]);
    } else if (def && cls && def[2] === "def" && indent === (cls.inner ??= indent)) {
      const s: Sym = { name: def[3], kind: "method", line: i + 1, parent: cls.name };
      symbols.push(s);
      bodies.push([s, i, indent]);
    } else if (indent === 0) {
      const c = l.match(/^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/); // module-level CONSTANT = ...
      if (c) symbols.push({ name: c[1], kind: "const", line: i + 1 });
    }
  });

  const local = new Set(symbols.filter((s) => !s.parent).map((s) => s.name));
  for (const [s, start, indent] of bodies) {
    let end = start + 1;
    while (end < lines.length && (lines[end].search(/\S/) < 0 || lines[end].search(/\S/) > indent)) end++;
    while (end > start + 1 && !lines[end - 1].trim()) end--; // trailing blank lines aren't part of it
    s.end = end;
    if (s.kind === "class") continue; // its methods carry the calls
    const body = lines.slice(start + 1, end).join("\n");
    const calls = new Set<string>();
    for (const [, ns, attr] of body.matchAll(/\b(\w+)\.(\w+)/g)) if (namespaces.has(ns) && !local.has(attr)) calls.add(attr);
    for (const [id] of body.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      const orig = alias.get(id);
      if (orig) calls.add(orig);
      else if (local.has(id) && id !== s.name) calls.add(id);
    }
    if (calls.size) s.calls = [...calls].sort();
  }
  const main = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(src) || undefined;
  return { specs: [...specs], names, symbols, main };
}

// ---- Go, Java, Rust: regex scan of conventionally formatted code (gofmt / rustfmt / Java's usual layout).
// shortcut: braces inside block comments or raw/multi-line strings throw block ends off; switch to a real parser if that bites.
const code = (l: string) => l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|\/\/.*$/g, '""');

/** 1-based last line of the definition starting at line index `start`: its closing brace, or its own line when it has no body. */
function blockEnd(lines: string[], start: number): number {
  const indent = lines[start].search(/\S/);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    // the next item starts before any "{": this one had no body (Go `type X int`)
    if (i > start && !depth && t && lines[i].search(/\S/) <= indent && !/^(where|throws)\b|^[{)-]/.test(t)) return start + 1;
    for (const c of code(lines[i])) {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i + 1;
      else if (c === ";" && !depth) return i + 1;
    }
  }
  return start + 1;
}

// names called (followed by "(") or mentioned as a type (CamelCase); unknown ones are dropped when resolved
const MENTION = /\b[A-Za-z_]\w*(?=\s*\()|\b[A-Z]\w*/g;

/** Names a definition calls or mentions as a type. Unknown ones (builtins, locals, packages) are dropped when resolved. */
function bodyCalls(lines: string[], s: Sym, alias: Map<string, string>): void {
  const text = lines.slice(s.line - 1, s.end).map(code).join("\n");
  const calls = new Set<string>();
  for (const [id] of text.matchAll(MENTION)) {
    const name = alias.get(id) ?? id;
    if (name !== s.name && name !== s.parent) calls.add(name);
  }
  if (calls.size) s.calls = [...calls].sort();
}

type Top = { sym?: Omit<Sym, "line">; container?: string }; // container: methods indented under it belong to it

/** Indent of the code inside the first `namespace X {` block (C#'s usual 4; 0 for C++'s unindented style or none). */
function namespaceIndent(lines: string[], header: RegExp): number {
  const at = lines.findIndex((l) => header.test(l));
  const next = at < 0 ? undefined : lines.slice(at + 1).find((l) => l.trim() && l.trim() !== "{");
  return next ? next.search(/\S/) : 0;
}

function blockSymbols(
  src: string,
  top: (l: string) => Top | undefined,
  member: (l: string, cls: string) => string | undefined,
  alias = new Map<string, string>(),
  topIndent = 0, // where top-level definitions start: inside a namespace block they're indented
): Sym[] {
  const lines = src.split(/\r?\n/);
  const symbols: Sym[] = [];
  let cls: { name: string; inner?: number } | undefined;
  lines.forEach((l, i) => {
    const indent = l.search(/\S/);
    // comments, and #include / #region / #[derive(..)] lines
    if (indent < 0 || /^\s*(\/\/|\/\*|\*|#)/.test(l)) return;
    if (indent < topIndent) cls = undefined; // the namespace block's own lines
    else if (indent === topIndent) {
      const t = top(l.trimStart());
      // only a new definition or the closing brace ends a class: C++ puts `public:` at the class's own indent
      if (t) cls = t.container ? { name: t.container } : undefined;
      else if (l.trimStart().startsWith("}")) cls = undefined;
      if (t?.sym) symbols.push({ ...t.sym, line: i + 1, end: blockEnd(lines, i) });
    } else if (cls) {
      const name = member(l.trim(), cls.name);
      if (name && indent === (cls.inner ??= indent))
        symbols.push({ name, kind: "method", line: i + 1, end: blockEnd(lines, i), parent: cls.name });
    }
  });
  for (const s of symbols) bodyCalls(lines, s, alias);
  return symbols;
}

const goExported = (name: string) => /^[A-Z]/.test(name);
const goTop = (l: string): Top | undefined => {
  let m = l.match(/^func\s+\(\s*(?:\w+\s+)?\*?\s*(\w+)[^)]*\)\s*(\w+)/);
  if (m) return { sym: { name: m[2], kind: "method", parent: m[1], exported: goExported(m[2]) } };
  if ((m = l.match(/^func\s+(\w+)/))) return { sym: { name: m[1], kind: "function", exported: goExported(m[1]) } };
  if ((m = l.match(/^type\s+(\w+)(.*)/))) {
    const kind = /^(\[[^\]]*\])?\s*(struct|interface)\b/.test(m[2].trim()) ? "class" : "type";
    return { sym: { name: m[1], kind, exported: goExported(m[1]) } };
  }
};

/** Go: import paths; a package import makes its exported names usable as pkg.Name, so it takes "*". */
export function parseGo(src: string): Parsed {
  const specs = new Set<string>();
  const names: Record<string, string[]> = {};
  const add = (alias: string | undefined, path: string) => {
    specs.add(path);
    if (alias !== "_") pushUnique(names, path, "*"); // `_` imports only for side effects
  };
  for (const [, block] of src.matchAll(/^import\s*\(([^)]*)\)/gm))
    for (const [, alias, path] of block.matchAll(/^\s*(\w+|\.)?\s*"([^"]+)"/gm)) add(alias, path);
  for (const [, alias, path] of src.matchAll(/^import\s+(\w+|\.)?\s*"([^"]+)"/gm)) add(alias, path);
  return { specs: [...specs], names, symbols: blockSymbols(src, goTop, () => undefined) };
}

const JAVA_MODS = "public|protected|private|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed";
const JAVA_TOP = new RegExp(
  `^(?:@\\w+(?:\\([^)]*\\))?\\s+)*((?:(?:${JAVA_MODS})\\s+)*)(?:class|interface|enum|record|@interface)\\s+(\\w+)`,
);
const javaTop = (l: string): Top | undefined => {
  const m = l.match(JAVA_TOP);
  return m ? { sym: { name: m[2], kind: "class", exported: /\bpublic\b/.test(m[1]) }, container: m[2] } : undefined;
};
const JAVA_MEMBER = new RegExp(
  `^(?:@\\w+(?:\\([^)]*\\))?\\s+)*((?:(?:${JAVA_MODS})\\s+)*)(?:<[^>]*>\\s+)?(?:([\\w.$]+(?:<.*?>)?(?:\\[\\])*)\\s+)?(\\w+)\\s*\\(`,
);
const NOT_A_TYPE = new Set(["return", "new", "throw", "else", "case", "yield"]);
const javaMember = (l: string, cls: string) => {
  const m = l.match(JAVA_MEMBER);
  if (!m || NOT_A_TYPE.has(m[2] ?? "")) return undefined;
  // a statement like `doIt(x);` has neither modifiers nor a return type; a constructor is named after its class
  return m[1] || m[2] || m[3] === cls ? m[3] : undefined;
};

/** Java: "a.b.C" for `import a.b.C;`, "a.b.*" for a package, "a.b.C.m" for a static import; the name is the last part. */
export function parseJava(src: string): Parsed {
  const names: Record<string, string[]> = {};
  for (const [, spec] of src.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm))
    pushUnique(names, spec, spec.split(".").pop()!);
  return { specs: Object.keys(names), names, symbols: blockSymbols(src, javaTop, javaMember) };
}

const RS_VIS = /^pub(?:\([^)]*\))?\s+/;
const RS_FN = /^(?:(?:async|const|unsafe|extern\s+"\w+")\s+)*fn\s+(\w+)/;
const rsTop = (l: string): Top | undefined => {
  const exported = RS_VIS.test(l);
  const rest = l.replace(RS_VIS, "");
  let m = rest.match(RS_FN);
  if (m) return { sym: { name: m[1], kind: "function", exported } };
  if ((m = rest.match(/^(struct|enum|union|trait)\s+(\w+)/)))
    return { sym: { name: m[2], kind: "class", exported }, container: m[1] === "trait" ? m[2] : undefined };
  if ((m = rest.match(/^type\s+(\w+)/))) return { sym: { name: m[1], kind: "type", exported } };
  if ((m = rest.match(/^(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/))) return { sym: { name: m[1], kind: "const", exported } };
  if (rest.startsWith("impl")) {
    let t = rest;
    while (/<[^<>]*>/.test(t)) t = t.replace(/<[^<>]*>/g, ""); // drop generics: impl<T> Trait for Foo<T>
    const impl = t.match(/^impl\s+(?:.*?\bfor\s+)?(?:\w+::)*(\w+)/);
    return impl ? { container: impl[1] } : undefined;
  }
};
const rsMember = (l: string) => l.replace(RS_VIS, "").match(RS_FN)?.[1];

/** `a::{b, c::{D, E}}` -> ["a::b", "a::c::D", "a::c::E"]; `a::{self}` -> "a". */
function expandUse(p: string): string[] {
  const open = p.indexOf("{");
  if (open < 0) return [p.trim()];
  const prefix = p.slice(0, open).trim();
  const inner = p.slice(open + 1, p.lastIndexOf("}"));
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "{") depth++;
    else if (inner[i] === "}") depth--;
    else if (inner[i] === "," && !depth) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => expandUse(s === "self" ? prefix.replace(/::$/, "") : prefix + s));
}

/** Rust: `use` paths ("crate::a::B") and `mod m;` as "self::m". Names: the item imported, plus x for every `m::x` in the file. */
export function parseRust(src: string): Parsed {
  const specs = new Set<string>();
  const names: Record<string, string[]> = {};
  const alias = new Map<string, string>();
  const local: [string, string][] = []; // spec, the name this file uses it by
  for (const [, mod] of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) local.push([`self::${mod}`, mod]);
  for (const [, tree] of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm))
    for (const item of expandUse(tree.replace(/\s+/g, " "))) {
      const [path, as] = item.split(/\s+as\s+/);
      const last = path.split("::").pop()!;
      if (last === "*") {
        specs.add(path.slice(0, -3));
        pushUnique(names, path.slice(0, -3), "*");
        continue;
      }
      pushUnique(names, path, last);
      if (as && as !== "_") alias.set(as, last);
      local.push([path, as ?? last]);
    }
  for (const [spec, name] of local) {
    specs.add(spec);
    for (const [, x] of src.matchAll(new RegExp(`\\b${name}::(\\w+)`, "g"))) pushUnique(names, spec, x);
  }
  // paths used without a `use`: `serde_json::to_string(..)`, `std::fs::read`, `my_crate::run()`. A lowercase first
  // segment is a crate or module (types are CamelCase); names already brought in by use/mod are covered above
  const inScope = new Set(local.map(([, name]) => name));
  const body = src.replace(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[^;]+;/gm, "").split(/\r?\n/).map(code).join("\n");
  for (const [, first, next] of body.matchAll(/(?<![\w:])([a-z_]\w*)::(\w+)/g)) {
    if (inScope.has(first)) continue;
    specs.add(`${first}::${next}`);
    pushUnique(names, `${first}::${next}`, next);
  }
  return { specs: [...specs], names, symbols: blockSymbols(src, rsTop, rsMember, alias) };
}

// ---- C / C++: definitions at the top level or inside an unindented `namespace x {` (LLVM/Google style)
const C_KEYWORD = /^(if|for|while|switch|return|else|do|case|sizeof|typedef|using|namespace|template|extern|static_assert|goto|delete|new|throw|friend)\b/;
const C_TYPE = /^(?:typedef\s+)?(struct|class|union|enum(?:\s+class|\s+struct)?)\s+(?:\w+\s+)*?(\w+)\s*(?:final\s*)?(?::[^{;]*)?(\{.*)?$/;
// return type tokens, then a name that may be qualified (Foo::bar, Foo::~Foo), then "("
const C_FN = /^((?:[\w:<>,*&[\]]+[\s*&]+)*)((?:\w+::)*~?\w+)\s*\(/;
const C_NOT_TYPE = new Set(["return", "new", "delete", "throw", "else", "case", "goto", "co_return", "co_await"]);

const cTop = (l: string): Top | undefined => {
  if (C_KEYWORD.test(l)) return undefined;
  let m = l.match(C_TYPE);
  if (m) return { sym: { name: m[2], kind: "class", exported: true }, container: m[2] };
  m = l.match(C_FN);
  if (!m || (!m[1] && /;\s*$/.test(l))) return undefined; // `MACRO(x);` is a call, not a definition
  const parts = m[2].split("::");
  const name = parts.pop()!;
  const parent = parts.pop(); // Foo::bar is method bar of class Foo
  return { sym: { name, kind: parent ? "method" : "function", parent, exported: !/\bstatic\b/.test(m[1]) } };
};
const cMember = (l: string, cls: string) => {
  const m = l.match(C_FN);
  if (!m || C_KEYWORD.test(l) || C_NOT_TYPE.has(m[1].trim().split(/\s+/).pop() ?? "")) return undefined;
  // a member has a return type, except constructors and destructors
  return m[1] || m[2] === cls || m[2] === `~${cls}` ? m[2] : undefined;
};

/** C / C++: `#include "x.h"` as "x.h", `#include <x.h>` as "<x.h>". Prototypes are skipped: the file with the body defines. */
export function parseC(src: string): Parsed {
  const names: Record<string, string[]> = {};
  for (const [, open, path] of src.matchAll(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm))
    pushUnique(names, open === "<" ? `<${path}>` : path, "*");
  const lines = src.split(/\r?\n/);
  const symbols = blockSymbols(src, cTop, cMember, new Map(), namespaceIndent(lines, /^namespace\s*[\w:]*\s*\{\s*(\/\/.*)?$/)).filter(
    (s) => s.kind !== "function" || lines.slice(s.line - 1, s.end).map(code).join("\n").includes("{"),
  );
  return { specs: Object.keys(names), names, symbols };
}

// ---- C#: types at the top level or one level into a `namespace X { }` block; `namespace X;` (file-scoped) keeps them at 0
const CS_MODS = "public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly|required|file";
const CS_TOP = new RegExp(`^(?:\\[.*?\\]\\s*)*((?:(?:${CS_MODS}|ref)\\s+)*)(class|struct|interface|enum|record(?:\\s+class|\\s+struct)?)\\s+(\\w+)`);
const CS_MEMBER = new RegExp(
  `^((?:(?:${CS_MODS})\\s+)*)(?:([\\w.<>\\[\\]?,]+(?:\\s+[\\w.<>\\[\\]?,]+)*?)\\s+)?(\\w+)\\s*(?:<[^>()]*>)?\\s*\\(`,
);
const CS_NOT_TYPE = new Set(["return", "new", "throw", "else", "case", "await", "yield", "using", "lock", "foreach", "if", "while"]);

const csTop = (l: string): Top | undefined => {
  const m = l.match(CS_TOP);
  return m ? { sym: { name: m[3], kind: "class", exported: /\bpublic\b/.test(m[1]) }, container: m[3] } : undefined;
};
const csMember = (l: string, cls: string) => {
  const m = l.match(CS_MEMBER);
  if (!m || CS_NOT_TYPE.has(m[2] ?? "")) return undefined;
  return m[1] || m[2] || m[3] === cls ? m[3] : undefined; // a constructor has no return type
};

/** C#: `using A.B;` as "A.B" (also `using static` / `using X = ...`). Which files that reaches is decided once all files
 * are parsed, from the namespaces each declares. */
export function parseCSharp(src: string): Parsed {
  const names: Record<string, string[]> = {};
  for (const [, ns] of src.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm)) names[ns] = [];
  const namespaces = [...new Set([...src.matchAll(/^\s*namespace\s+([\w.]+)/gm)].map((m) => m[1]))];
  const lines = src.split(/\r?\n/);
  const refs = new Set([...lines.map(code).join("\n").matchAll(MENTION)].map((m) => m[0]));
  const symbols = blockSymbols(src, csTop, csMember, new Map(), namespaceIndent(lines, /^namespace\s+[\w.]+\s*\{?\s*$/));
  return { specs: Object.keys(names), names, symbols, namespaces, refs: [...refs].sort() };
}
