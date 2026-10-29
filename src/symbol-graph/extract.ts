import type ts from 'typescript';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { classifyFileReference } from '../storage/file-references.js';
import { repoPaths } from '../storage/repo.js';
import type { Capability } from '../storage/types.js';

const require = createRequire(import.meta.url);

export type SymbolEdge = { source: string; target: string; relation: 'calls' | 'imports'; file: string; line: number };

/** Only statically resolved TS/JS declarations inside the indexed source set are connected. */
export function extractSymbolGraph(files: Array<{ filePath: string; module: string }>, existing: Capability[]) {
  const ts: typeof import('typescript') = require('typescript');
  const supported = files.filter(f => /\.[cm]?[jt]sx?$/.test(f.filePath));
  const sources = new Map<string, ts.SourceFile>();
  for (const file of supported) {
    const reference = classifyFileReference(file.filePath);
    if (reference.kind !== 'file') continue;
    const text = readFileSync(reference.absolutePath, 'utf8');
    sources.set(resolve(reference.absolutePath), ts.createSourceFile(reference.absolutePath, text, ts.ScriptTarget.Latest, true));
  }
  const host: ts.CompilerHost = {
    fileExists: path => sources.has(resolve(path)), readFile: path => sources.get(resolve(path))?.text,
    getSourceFile: path => sources.get(resolve(path)), getDefaultLibFileName: () => '',
    writeFile: () => {}, getCurrentDirectory: () => repoPaths().root, getDirectories: () => [],
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(name => {
      if (!name.startsWith('.')) return undefined;
      const base = resolve(dirname(containing), name);
      const stem = base.replace(/\.[cm]?jsx?$/, '');
      const found = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map(ext => stem + ext),
        ...['index.ts', 'index.tsx', 'index.js'].map(file => resolve(base, file))].find(path => sources.has(path));
      return found ? { resolvedFileName: found } : undefined;
    }),
  };
  const program = ts.createProgram([...sources.keys()], { noLib: true, allowJs: true, noEmit: true }, host);
  const checker = program.getTypeChecker();
  const nodes: Capability[] = [];
  const claimed = new Set<string>();
  const existingByLocation = new Map<string, Capability[]>();
  for (const node of existing) {
    const key = `${node.filePath}#${node.name}:${node.lineStart}`;
    const list = existingByLocation.get(key) ?? []; list.push(node); existingByLocation.set(key, list);
  }
  const declarations = new Map<ts.Node, Capability>();
  const fileNodes = new Map<ts.SourceFile, Capability>();
  const line = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  for (const file of supported) {
    const source = sources.get(resolve(repoPaths().root, file.filePath));
    if (!source) continue;
    const fileNode: Capability = { id: `source:${file.filePath}`, name: file.filePath, kind: 'file', module: file.module,
      filePath: file.filePath, lineStart: 1, lineEnd: source.getLineAndCharacterOfPosition(source.end).line + 1, exported: false };
    nodes.push(fileNode); fileNodes.set(source, fileNode);
    const visit = (node: ts.Node) => {
      const named = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
        || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node);
      const variable = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
      if ((named || variable) && ('name' in node || ts.isConstructorDeclaration(node))) {
        const name = ts.isConstructorDeclaration(node) ? 'constructor' : (node as ts.NamedDeclaration).name?.getText(source);
        if (name) {
          const start = line(node);
          const prior = (existingByLocation.get(`${file.filePath}#${name}:${start}`) ?? []).find(c => !claimed.has(c.id));
          if (prior) claimed.add(prior.id);
          const capability: Capability = { ...prior, id: prior?.id ?? `symbol:${file.filePath}:${node.pos}`, name,
            kind: prior?.kind ?? (ts.isClassDeclaration(node) ? 'class' : variable ? 'constant' : 'function'), module: file.module, filePath: file.filePath, lineStart: start,
            lineEnd: source.getLineAndCharacterOfPosition(node.end).line + 1, exported: prior?.exported ?? false };
          declarations.set(node, capability); nodes.push(capability);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const edges: SymbolEdge[] = [];
  const targetFor = (name: ts.Node) => {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.map(d => declarations.get(d)).find(Boolean);
  };
  for (const [source, fileNode] of fileNodes) {
    const visit = (node: ts.Node, owner: Capability) => {
      if (!ts.isVariableDeclaration(node) || node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        owner = declarations.get(node) ?? owner;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expr = node.expression;
        const target = targetFor(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
        if (target) edges.push({ source: owner.id, target: target.id, relation: 'calls', file: fileNode.filePath, line: line(node) });
      }
      if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) {
        const name = node.name;
        if (name) {
          const target = targetFor(name);
          if (target) edges.push({ source: fileNode.id, target: target.id, relation: 'imports', file: fileNode.filePath, line: line(node) });
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    };
    visit(source, fileNode);
  }
  return { nodes, edges, coverage: { supportedFiles: fileNodes.size, unsupportedFiles: files.length - supported.length,
    limitation: 'Static TS/JS calls and named/default imports only; dynamic dispatch, external packages and other languages are not complete.' } };
}
