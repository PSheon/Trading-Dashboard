import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("every body/query/params boundary uses a runtime class DTO, without inline parsers", () => {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".controller.ts")) files.push(path);
    }
  }
  walk(join(process.cwd(), "src"));
  let boundaries = 0;
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toMatch(/\bparseOr400\b|\.safeParse\(/);
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const runtimeImports = new Set<string>();
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (!item.isTypeOnly) runtimeImports.add(item.name.text);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isParameter(node)) {
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
        for (const decorator of decorators) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !["Body", "Query", "Param", "ResumeHeader"].includes(call.expression.text)) continue;
          boundaries++;
          const type = node.type;
          expect(type && ts.isTypeReferenceNode(type), `${path}: ${node.getText(file)}`).toBe(true);
          const name = type && ts.isTypeReferenceNode(type) ? type.typeName.getText(file) : "";
          expect(name, path).toMatch(/Dto$/);
          expect(runtimeImports.has(name), `${path}: ${name} must not be import type`).toBe(true);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(boundaries).toBeGreaterThan(25);
});
