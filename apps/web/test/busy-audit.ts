import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Walks every component and page with the type checker and lists each
 * pressable whose handler starts async work but which shows no busy state.
 *
 * - A pressable: `<Button>`, `<TextButton>`, `<button>`, `<DropdownMenuItem>`, through
 *   `onClick` / `onSelect`; a submit button through its form's `onSubmit`.
 * - Async: the handler (or a function it calls, three levels deep, across
 *   files) awaits, calls a mutation's `mutate`/`mutateAsync`, or calls
 *   anything whose result is a Promise.
 * - Busy state: `<Button loading={…}>`, `<TextButton busy={…}>`, or
 *   `aria-busy` on anything else.
 *   A pressable whose async work is instant and has nothing to show
 *   (clipboard, a local file save) says so with a `busy-exempt: <why>`
 *   comment inside its tag.
 */
export type Finding = { file: string; line: number; tag: string; handler: string };

const SRC = join(__dirname, "../src");

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

/** `root`: the tree to check (the app's src by default; a test fixture). */
export function auditBusyButtons(root = SRC): Finding[] {
  const roots = root === SRC ? files(SRC) : [...files(root), ...files(join(SRC, "components/ui"))];
  const program = ts.createProgram(roots, {
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    baseUrl: join(__dirname, ".."),
    paths: { "@/*": ["./src/*"] },
    lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.esnext.d.ts"],
  });
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];

  const isPromiseType = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(isPromiseType);
    const then = type.getProperty("then");
    return Boolean(then) && (type.symbol?.name === "Promise" || type.symbol?.name === "PromiseLike" || checker.typeToString(type).startsWith("Promise<"));
  };

  const fromSrc = (node: ts.Node) => {
    const file = node.getSourceFile().fileName;
    return (file.startsWith(SRC) && !file.includes("/fixtures/")) || file.startsWith(root);
  };

  /** The function a symbol names, when it is one we can read. */
  const functionOf = (symbol: ts.Symbol | undefined): ts.Node | undefined => {
    if (!symbol) return undefined;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const decl of target.declarations ?? []) {
      if (!fromSrc(decl)) continue;
      if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        let init: ts.Expression = decl.initializer;
        // useCallback(fn, deps)
        if (ts.isCallExpression(init) && /useCallback$/.test(init.expression.getText()) && init.arguments[0]) init = init.arguments[0];
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      }
      if (ts.isPropertyAssignment(decl) && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return decl.initializer;
    }
    return undefined;
  };

  const asyncCache = new Map<ts.Node, boolean>();
  const isAsyncFunction = (fn: ts.Node, depth: number): boolean => {
    if (asyncCache.has(fn)) return asyncCache.get(fn)!;
    asyncCache.set(fn, false); // cycles
    let found = ts.canHaveModifiers(fn) && (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const visit = (node: ts.Node) => {
      if (found) return;
      // A nested function is only async work when it is called.
      if (node !== fn && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) {
        // setTimeout(() => …) / startTransition(() => …) callbacks still run.
        if (node.parent && ts.isCallExpression(node.parent)) ts.forEachChild(node, visit);
        return;
      }
      if (ts.isAwaitExpression(node)) { found = true; return; }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && /^(mutate|mutateAsync)$/.test(callee.name.text)) { found = true; return; }
        if (isPromiseType(checker.getTypeAtLocation(node))) { found = true; return; }
        if (depth < 3) {
          const target = functionOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
          if (target && isAsyncFunction(target, depth + 1)) { found = true; return; }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    asyncCache.set(fn, found);
    return found;
  };

  const isAsyncHandler = (expr: ts.Expression): boolean => {
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return isAsyncFunction(expr, 0);
    // onClick={save.mutate}
    if (ts.isPropertyAccessExpression(expr) && /^(mutate|mutateAsync)$/.test(expr.name.text)) return true;
    const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    const fn = functionOf(symbol);
    if (fn) return isAsyncFunction(fn, 0);
    const type = checker.getTypeAtLocation(expr);
    return type.getCallSignatures().some((signature) => isPromiseType(signature.getReturnType()));
  };

  const attribute = (opening: ts.JsxOpeningLikeElement, name: string) =>
    opening.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
  const handlerOf = (attr: ts.JsxAttribute | undefined) =>
    attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;

  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(root) || !source.fileName.endsWith(".tsx")) continue;
    if (source.fileName.includes("/components/ui/")) continue;
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        if (tag === "Button" || tag === "TextButton" || tag === "button" || tag === "DropdownMenuItem") {
          let handler = handlerOf(attribute(node, "onClick")) ?? handlerOf(attribute(node, "onSelect"));
          const type = attribute(node, "type");
          if (!handler && type?.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === "submit") {
            for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
              if (ts.isJsxElement(up) && up.openingElement.tagName.getText() === "form") {
                handler = handlerOf(attribute(up.openingElement, "onSubmit"));
                break;
              }
            }
          }
          if (handler && isAsyncHandler(handler)) {
            const busy = tag === "Button" ? attribute(node, "loading") : tag === "TextButton" ? attribute(node, "busy") : attribute(node, "aria-busy");
            if (!busy && !node.getText().includes("busy-exempt")) {
              const { line } = source.getLineAndCharacterOfPosition(node.getStart());
              findings.push({ file: relative(root, source.fileName), line: line + 1, tag, handler: handler.getText().slice(0, 80) });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
