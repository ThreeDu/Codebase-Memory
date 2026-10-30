import ts from "typescript";

export interface Sym {
  name: string;
  kind: "function" | "class" | "method" | "const" | "type";
  line: number;
  exported?: boolean;
  parent?: string; // class name, for methods
  calls?: string[]; // imported names (as exported by their module) and same-file top-level names used in the body
}
export interface Parsed {
  specs: string[]; // raw import specifiers
  names: Record<string, string[]>; // spec -> names imported from it ("*" for a whole-module import)
  symbols: Sym[];
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
      line: line(st),
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
        const s: Sym = { name: left.name.text, kind: isFn(right) ? "function" : "const", line: line(st), exported: true };
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
      const s: Sym = { name: st.name.text, kind: "function", line: line(st), exported: exported(st) || cjsExported.has(st.name.text) };
      symbols.push(s);
      bodies.push([s, st]);
    } else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text;
      symbols.push({ name: cls, kind: "class", line: line(st), exported: exported(st) || cjsExported.has(cls) });
      for (const m of st.members) {
        const isMethod =
          ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || (ts.isPropertyDeclaration(m) && isFn(m.initializer));
        if (!isMethod) continue;
        const s: Sym = { name: m.name ? m.name.getText(sf) : "constructor", kind: "method", line: line(m), parent: cls };
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
        const s: Sym = { name: d.name.text, kind: fn ? "function" : "const", line: line(d), exported: isExported };
        symbols.push(s);
        if (d.initializer) bodies.push([s, d.initializer]);
      }
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      symbols.push({ name: st.name.text, kind: "type", line: line(st), exported: exported(st) });
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
      else bodies.push([s, i, 0]);
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
  return { specs: [...specs], names, symbols };
}
