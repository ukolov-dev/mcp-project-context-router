import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { extractLanguageCapabilities } from './languages.js';
import { loadProjectConfig, type ProjectConfig } from '../storage/config.js';
import { inferModulesFromPath, sourceGlobMayMatchPath, sourceGlobsForModule } from '../storage/inference.js';
import type { Capability, Endpoint } from '../storage/types.js';
import { repoPaths } from '../storage/repo.js';

// Bump when discovery rules change so existing consumer indexes are rebuilt.
const capabilityDiscoveryVersion = 'native-languages-v1';

export function isCapabilitySourcePath(filePath: string): boolean {
  const config = loadProjectConfig();
  return Object.values(config.modules)
    .flatMap(sourceGlobsForModule)
    .some((glob) => sourceGlobMayMatchPath(glob, filePath));
}

export function inferModule(filePath: string): string {
  return inferModulesFromPath(filePath)[0] ?? 'unknown';
}

export function discoverCapabilities(): { capabilities: Capability[]; endpoints: Endpoint[]; sourceFingerprint: string } {
  const paths = repoPaths();
  const files = capabilitySourceFiles();
  const capabilities: Capability[] = [];
  const endpoints: Endpoint[] = [];
  const fingerprint = createHash('sha256').update(capabilityDiscoveryVersion);

  for (const { filePath, module } of files) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(text).update('\0');
    const lines = text.split(/\r?\n/);
    if (filePath.endsWith('.cs')) {
      extractCSharpCapabilities(filePath, module, text, capabilities, endpoints);
    } else if (/\.(?:py|go|rs)$/.test(filePath)) {
      for (const capability of extractLanguageCapabilities(filePath, module, text)) push(capabilities, capability);
    } else {
      extractTsCapabilities(filePath, module, lines, capabilities);
      extractJavaCapabilities(filePath, module, lines, capabilities, endpoints);
    }
    extractDocsCapabilities(filePath, module, lines, capabilities);
  }

  return { capabilities, endpoints, sourceFingerprint: fingerprint.digest('hex') };
}

export function discoverCapabilitySourceFingerprint(): string {
  const paths = repoPaths();
  const fingerprint = createHash('sha256').update(capabilityDiscoveryVersion);
  for (const { filePath, module } of capabilitySourceFiles()) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return fingerprint.digest('hex');
}

export function discoverCapabilitySourceStateFingerprint(): string {
  const paths = repoPaths();
  const fingerprint = createHash('sha256').update(capabilityDiscoveryVersion);
  for (const { filePath, module } of capabilitySourceFiles()) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(`${stat.size}:${stat.mtimeMs}`).update('\0');
  }
  return fingerprint.digest('hex');
}

function capabilitySourceFiles(): Array<{ filePath: string; module: string }> {
  const config = loadProjectConfig();
  const files = new Map<string, string>();
  for (const [moduleName, module] of Object.entries(config.modules)) {
    for (const filePath of discoverModuleFiles(config, moduleName)) {
      if (!files.has(filePath)) files.set(filePath, moduleName);
    }
  }
  return [...files.entries()]
    .map(([filePath, module]) => ({ filePath, module }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function discoverModuleFiles(config: ProjectConfig, moduleName: string): string[] {
  const module = config.modules[moduleName];
  if (!module) return [];
  return fg.sync(sourceGlobsForModule(module).map((glob) => glob.replaceAll('\\', '/')), {
    cwd: repoPaths().root,
    absolute: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [
      '**/.git/**',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/coverage/**',
      '**/target/**',
      '**/vendor/**',
    ],
  });
}

function push(capabilities: Capability[], item: Omit<Capability, 'id'>): void {
  capabilities.push({
    id: `${item.filePath}:${item.kind}:${item.name}:${item.lineStart ?? 0}`,
    ...item,
  });
}

function extractTsCapabilities(filePath: string, module: string, lines: string[], capabilities: Capability[]): void {
  lines.forEach((line, index) => {
    const exports = /\bexport\b/.test(line);
    const fn = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    const cnst = /\b(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/.exec(line);
    const type = /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/.exec(line);
    const match = fn ?? cnst ?? type;
    if (!match) return;
    const name = match[1];
    const kind = fn ? (name.startsWith('use') ? 'hook' : /^[A-Z]/.test(name) ? 'component' : 'function') : type ? 'type' : /^[A-Z]/.test(name) ? 'component' : 'constant';
    push(capabilities, {
      name,
      kind,
      module,
      filePath,
      lineStart: index + 1,
      lineEnd: index + 1,
      signature: line.trim(),
      exported: exports,
    });
  });
}

function extractJavaCapabilities(
  filePath: string,
  module: string,
  lines: string[],
  capabilities: Capability[],
  endpoints: Endpoint[],
): void {
  let currentClass: string | undefined;
  let currentBasePath = '';
  lines.forEach((line, index) => {
    const classMatch = /\b(public\s+)?(class|record|interface|enum)\s+([A-Za-z0-9_]+)/.exec(line);
    if (classMatch) {
      currentClass = classMatch[3];
      push(capabilities, {
        name: currentClass,
        kind: classMatch[2],
        module,
        filePath,
        lineStart: index + 1,
        lineEnd: index + 1,
        signature: line.trim(),
        exported: Boolean(classMatch[1]),
      });
    }

    const requestMapping = /@RequestMapping\((?:value\s*=\s*)?"([^"]+)"/.exec(line);
    if (requestMapping) {
      currentBasePath = requestMapping[1];
    }

    const endpoint = /@(Get|Post|Put|Patch|Delete)Mapping\((?:value\s*=\s*)?"?([^")]+)?"?\)/.exec(line);
    if (endpoint) {
      const method = endpoint[1].toUpperCase().replace('DELETE', 'DELETE');
      const localPath = endpoint[2] && !endpoint[2].startsWith('produces') ? endpoint[2] : '';
      const path = normalizeEndpointPath(`${currentBasePath}/${localPath}`);
      endpoints.push({
        id: `${method}:${path}`,
        method,
        path,
        module,
        controllerSymbolId: currentClass ? `${filePath}:class:${currentClass}` : undefined,
        filePath,
      });
    }
  });
}

function extractCSharpCapabilities(
  filePath: string,
  module: string,
  text: string,
  capabilities: Capability[],
  endpoints: Endpoint[],
): void {
  const blank = (value: string) => value.replace(/[^\r\n]/g, ' ');
  const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|\$*("{3,})[\s\S]*?\1|\$?@"(?:[^"]|"")*"|@?\$"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
  const source = text.replace(tokens, (token) => token.startsWith('/') ? blank(token) : token);
  const code = text.replace(tokens, blank).replace(/^\s*#[^\r\n]*/gm, blank);
  const scopes: Array<{
    name: string; kind: string; id: string; routes: Array<string | undefined>; controller: boolean;
  } | undefined> = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let line = 1;
  let startLine = 1;

  // shortcut: declaration heuristics, use a C# parser when semantic or full grammar coverage is needed.
  for (let offset = 0; offset < code.length; offset++) {
    const char = code[offset];
    if (char === '\n') line++;
    if (char === '(') parentheses++;
    if (char === ')') parentheses--;
    if (char === '[') brackets++;
    if (char === ']') brackets--;
    if (parentheses > 0 || brackets > 0 || !/[{};]/.test(char)) continue;
    let header = code.slice(start, offset);
    let consumed = 0;
    const attributes: Array<{ name: string; template?: string; literal: boolean }> = [];
    for (let attr = /^\s*\[[^\]]*\]/.exec(header); attr; attr = /^\s*\[[^\]]*\]/.exec(header)) {
      const original = source.slice(start + consumed, start + consumed + attr[0].length);
      for (const match of attr[0].matchAll(/(?:\[|,)\s*(?:[\w.]+\.)?(Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions|NonAction|ActionName)(?:Attribute)?\b\s*(\()?/g)) {
        // Read parameters using masked delimiters so punctuation inside a route stays literal.
        const argsStart = match.index! + match[0].length;
        const argsEnd = match[2] ? attr[0].indexOf(')', argsStart) : argsStart;
        const args = original.slice(argsStart, argsEnd);
        let template: string | undefined;
        const literal = /^\s*(@"(?:[^"]|"")*"|"(?:\\.|[^"\\])*")\s*(?:,|$)/.exec(args);
        if (literal) {
          try {
            template = literal[1].startsWith('@') ? literal[1].slice(2, -1).replaceAll('""', '"') : JSON.parse(literal[1]);
          } catch { /* Unsupported C# string escape: omit the route. */ }
        } else if (!args.trim() && match[1].startsWith('Http')) {
          template = '';
        }
        attributes.push({ name: match[1], template, literal: Boolean(literal) });
      }
      consumed += attr[0].length;
      header = header.slice(attr[0].length);
    }
    const leading = /^\s*/.exec(header)![0];
    const declaration = header.trim();
    const declarationStart = start + consumed + leading.length;
    const declarationLine = startLine + code.slice(start, declarationStart).split('\n').length - 1;
    const owner = scopes.at(-1);
    const modifiers = /^((?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|ref|unsafe|new|virtual|override|async|extern|required|file)\s+)*)/.exec(declaration)![0];
    const rest = declaration.slice(modifiers.length);
    const type = /^(class|struct|record(?:\s+(?:class|struct))?|interface|enum)\s+(@?\w+)/.exec(rest);
    let scope: (typeof scopes)[number];
    const add = (name: string, kind: string, exported: boolean) => {
      push(capabilities, {
        name: name.replace(/^@/, ''), kind, module, filePath, lineStart: declarationLine, lineEnd: line,
        signature: text.slice(declarationStart, offset).trim(), exported,
      });
      return capabilities.at(-1)!.id;
    };
    if (type && (owner || !scopes.some(Boolean))) {
      const kind = type[1].startsWith('record') ? 'record' : type[1];
      const name = type[2].replace(/^@/, '');
      const id = add(name, kind, /\bpublic\b/.test(modifiers));
      scope = {
        name, kind, id,
        routes: attributes.filter((attr) => attr.name === 'Route').map((attr) => attr.template),
        controller: kind === 'class' && (/Controller$/.test(name) || /:\s*(?:[\w.]+\.)?Controller(?:Base)?\b/.test(rest)),
      };
    } else if (owner) {
      const method = /^(?:[\w@.]+(?:\s*<[^;(){}]+>)?(?:\[\])?\??\s+)?(@?\w+)(?:\s*<[^(){}]+>)?\s*\(/.exec(rest);
      const property = /^[\w@.]+(?:\s*<[^;(){}]+>)?(?:\[\])?\??\s+(@?\w+)\s*(?:=>|$)/.exec(rest);
      const name = (method ?? property)?.[1];
      if (name) {
        const kind = method ? name.replace(/^@/, '') === owner.name ? 'constructor' : 'method' : 'property';
        const exported = /\bpublic\b/.test(modifiers) || (owner.kind === 'interface' && !/\b(?:private|protected|internal)\b/.test(modifiers));
        add(name, kind, exported);
        if (kind === 'method' && owner.controller && exported && !/\bstatic\b/.test(modifiers) && !attributes.some((attr) => attr.name === 'NonAction')) {
          const routes = attributes.filter((attr) => attr.name === 'Route');
          const action = attributes.find((attr) => attr.name === 'ActionName')?.template ?? name.replace(/Async$/, '').replace(/^@/, '');
          for (const verb of attributes.filter((attr) => attr.name.startsWith('Http') && attr.template !== undefined)) {
            const localRoutes = verb.literal ? [verb.template] : routes.length ? routes.map((attr) => attr.template) : [''];
            for (const local of localRoutes) {
              if (local === undefined) continue;
              const absolute = /^(?:\/|~\/)/.test(local);
              const bases = absolute ? [''] : owner.routes.length ? owner.routes : [''];
              for (const base of bases) {
                if (base === undefined || (!verb.literal && !base && !local && !routes.length && !owner.routes.length)) continue;
                const template = absolute ? local.replace(/^~/, '') : `${base}/${local}`;
                const path = normalizeEndpointPath(template
                  .replaceAll('[controller]', owner.name.replace(/Controller$/, ''))
                  .replaceAll('[action]', action));
                const method = verb.name.slice(4).toUpperCase();
                const id = `${method}:${path}`;
                if (!endpoints.some((endpoint) => endpoint.id === id && endpoint.filePath === filePath)) {
                  endpoints.push({ id, method, path, module, controllerSymbolId: owner.id, filePath });
                }
              }
            }
          }
        }
      }
    }
    if (char === '{') scopes.push(scope);
    if (char === '}') scopes.pop();
    start = offset + 1;
    startLine = line;
  }
}

function extractDocsCapabilities(filePath: string, module: string, lines: string[], capabilities: Capability[]): void {
  if (!filePath.endsWith('.md')) return;
  lines.forEach((line, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!heading) return;
    push(capabilities, {
      name: heading[2].trim(),
      kind: 'doc-heading',
      module,
      filePath,
      lineStart: index + 1,
      lineEnd: index + 1,
      signature: line.trim(),
      exported: false,
    });
  });
}

function normalizeEndpointPath(path: string): string {
  return `/${path.split('/').filter(Boolean).join('/')}`.replace(/\/$/, '') || '/';
}
