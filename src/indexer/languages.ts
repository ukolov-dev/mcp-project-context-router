import type { Capability } from '../storage/types.js';

type Declaration = Omit<Capability, 'id'>;
type Language = 'python' | 'go' | 'rust';
const identifier = '[\\p{L}_][\\p{L}\\p{N}\\p{M}_]*';

export function extractLanguageCapabilities(filePath: string, module: string, text: string): Declaration[] {
  const language: Language = filePath.endsWith('.py') ? 'python' : filePath.endsWith('.go') ? 'go' : 'rust';
  const code = maskLiterals(text, language);
  const declarations: Declaration[] = [];
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index! + 1)];
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  const emit = (name: string, kind: string, start: number, end: number, exported: boolean) => {
    declarations.push({ name: name.replace(/^r#/, ''), kind, filePath, module,
      lineStart: lineAt(start), lineEnd: lineAt(end), signature: text.slice(start, end).trim(), exported });
  };
  if (language === 'python') extractPython(code, emit);
  else if (language === 'go') extractGo(code, emit);
  else extractRust(code, emit);
  return declarations.sort((left, right) => left.lineStart! - right.lineStart!);
}

type Emit = (name: string, kind: string, start: number, end: number, exported: boolean) => void;

// shortcut: lexical declaration discovery, use native parsers when full grammar or semantic resolution is required.
function maskLiterals(text: string, language: Language): string {
  const chars = text.split('');
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  };
  for (let index = 0; index < text.length;) {
    const start = index;
    if ((language === 'python' && text[index] === '#') || (language !== 'python' && text.startsWith('//', index))) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
    } else if (language !== 'python' && text.startsWith('/*', index)) {
      index += 2;
      let depth = 1;
      while (index < text.length && depth) {
        if (text.startsWith('*/', index)) { depth--; index += 2; }
        else if (language === 'rust' && text.startsWith('/*', index)) { depth++; index += 2; }
        else index++;
      }
    } else {
      const raw = language === 'rust' ? /^r(#{0,255})"/.exec(text.slice(index)) : null;
      if (raw) {
        const delimiter = `"${raw[1]}`;
        const end = text.indexOf(delimiter, index + raw[0].length);
        index = end < 0 ? text.length : end + delimiter.length;
      } else if (language === 'go' && text[index] === '`') {
        const end = text.indexOf('`', index + 1);
        index = end < 0 ? text.length : end + 1;
      } else if (text[index] === '"' || (text[index] === "'" && (language !== 'rust'
        || /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^\r\n'\\])'/u.test(text.slice(index))))) {
        const quote = text[index];
        const delimiter = language === 'python' && text.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
        index += delimiter.length;
        while (index < text.length) {
          if (text[index] === '\\') index += Math.min(2, text.length - index);
          else if (text.startsWith(delimiter, index)) { index += delimiter.length; break; }
          else index++;
        }
      } else { index++; continue; }
    }
    blank(start, index);
  }
  return chars.join('');
}

function declarationEnd(code: string, start: number, language: Language, alias = false, minimumEnd = start): number {
  let parentheses = 0;
  let brackets = 0;
  let angles = 0;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if (char === '(') parentheses++;
    if (char === ')') parentheses--;
    if (char === '[') brackets++;
    if (char === ']') brackets--;
    if (language === 'rust' && char === '<') angles++;
    if (language === 'rust' && char === '>' && code[index - 1] !== '-' && angles > 0) angles--;
    if (parentheses || brackets || angles) continue;
    if (language === 'python' && char === (alias ? '=' : ':')) return index + 1;
    if (language !== 'python' && (char === '{' || char === ';')) return index;
    if (index >= minimumEnd && char === '\n' && language !== 'rust' && (language !== 'python' || code[index - 1] !== '\\')) return index;
  }
  return code.length;
}

function extractPython(code: string, emit: Emit): void {
  const pattern = new RegExp(`^([ \\t]*)(?:(?:async\\s+)?(def|class)\\s+(${identifier})|type\\s+(${identifier})|(${identifier})\\s*:\\s*(?:typing\\.)?TypeAlias\\b)`, 'u');
  const scopes: Array<{ indent: number; kind: string; exported: boolean }> = [];
  let offset = 0;
  let depth = 0;
  let continued = false;
  for (const line of code.split('\n')) {
    if (line.trim() && !depth && !continued) {
      const indent = [.../^[ \t]*/.exec(line)![0]].reduce((size, char) => char === '\t' ? size + 8 - size % 8 : size + 1, 0);
      while (scopes.length && scopes.at(-1)!.indent >= indent) scopes.pop();
      const match = pattern.exec(line);
      if (match) {
        const name = match[3] ?? match[4] ?? match[5];
        const kind = match[2] === 'class' ? 'class' : match[2] === 'def' ? scopes.at(-1)?.kind === 'class' ? 'method' : 'function' : 'type';
        const start = offset + match[1].length;
        const end = declarationEnd(code, start, 'python', kind === 'type');
        const delimiter = code[end - 1];
        if (delimiter === ':' || (kind === 'type' && delimiter === '=')) {
          const exported = !name.startsWith('_') && scopes.every((scope) => scope.kind === 'class' && scope.exported);
          emit(name, kind, start, end, exported);
          if (kind !== 'type') scopes.push({ indent, kind: kind === 'class' ? 'class' : 'function', exported });
        }
      }
    }
    for (const char of line) {
      if ('([{'.includes(char)) depth++;
      if (')]}'.includes(char)) depth--;
    }
    continued = /\\\s*$/.test(line);
    offset += line.length + 1;
  }
}

function extractGo(code: string, emit: Emit): void {
  const typeName = new RegExp(`^\\s*(${identifier})`, 'u');
  const addType = (start: number, end: number) => {
    const match = typeName.exec(code.slice(start, end));
    if (!match) return;
    const nameStart = start + match[0].length - match[1].length;
    const headerEnd = declarationEnd(code, nameStart, 'go');
    const rest = code.slice(nameStart + match[1].length, headerEnd);
    const kind = /^\s*(?:\[[\s\S]*\]\s*)?(struct|interface)\b/.exec(rest)?.[1] ?? 'type';
    emit(match[1], kind, nameStart, headerEnd, /^\p{Lu}/u.test(match[1]));
  };
  const functions = new RegExp(`\\bfunc\\b\\s*(?:\\([^)]*\\)\\s*)?(${identifier})\\s*(?=\\[|\\()`, 'gu');
  for (const match of code.matchAll(functions)) {
    const kind = /^func\s*\(/.test(match[0]) ? 'method' : 'function';
    emit(match[1], kind, match.index!, declarationEnd(code, match.index!, 'go', false, match.index! + match[0].length), /^\p{Lu}/u.test(match[1]));
  }
  const types = new RegExp(`\\btype\\b\\s*(?=${identifier}|\\()`, 'gu');
  for (const match of code.matchAll(types)) {
    let start = match.index! + match[0].length;
    if (code[start] !== '(') { addType(start, declarationEnd(code, start, 'go')); continue; }
    let depth = 0;
    start++;
    for (let index = start; index < code.length; index++) {
      const char = code[index];
      if (depth === 0 && (char === '\n' || char === ';' || char === ')')) {
        addType(start, index);
        start = index + 1;
        if (char === ')') break;
      }
      if ('([{'.includes(char)) depth++;
      if (')]}'.includes(char)) depth--;
    }
  }
}

function extractRust(masked: string, emit: Emit): void {
  const chars = masked.split('');
  const macros = new RegExp(`(?:macro_rules!\\s+${identifier}|(?:r#)?${identifier}(?:::(?:r#)?${identifier})*!)\\s*([([{])`, 'gu');
  for (let match = macros.exec(masked); match; match = macros.exec(masked)) {
    const start = match.index;
    const stack = [match[1]];
    let end = macros.lastIndex;
    while (end < masked.length && stack.length) {
      const char = masked[end++];
      if ('([{'.includes(char)) stack.push(char);
      else if (')]}'.includes(char)) stack.pop();
    }
    for (let index = start; index < end; index++) if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    macros.lastIndex = end;
  }
  const code = chars.join('');
  const pattern = new RegExp(`\\b(pub(?:\\s*\\([^)]*\\))?\\s+)?(?:(?:async|const|unsafe|extern|default)\\s+)*(fn|struct|enum|trait|union|type)\\s+((?:r#)?${identifier})`, 'gu');
  const matches = new Map([...code.matchAll(pattern)].map((match) => [match.index!, match]));
  const scopes: Array<{ kind: string; exported: boolean }> = [];
  let pending: { kind: string; exported: boolean } | undefined;
  let headerStart = 0;
  for (let index = 0; index < code.length; index++) {
    const match = matches.get(index);
    if (match) {
      const owner = scopes.at(-1);
      const kind = match[2] === 'fn' ? owner?.kind === 'impl' || owner?.kind === 'trait' ? 'method' : 'function' : match[2];
      const exported = match[1]?.trim() === 'pub' || (owner?.kind === 'trait' && owner.exported);
      emit(match[3], kind, index, declarationEnd(code, index, 'rust'), Boolean(exported));
      pending = { kind: match[2], exported: Boolean(exported) };
    }
    if (code[index] === '{') {
      const header = code.slice(headerStart, index);
      scopes.push(pending ?? { kind: /(?:^|[;{])\s*(?:#\[[\s\S]*?\]\s*)*(?:unsafe\s+)?impl\b/.test(header) ? 'impl' : 'other', exported: false });
      pending = undefined;
    } else if (code[index] === '}') { scopes.pop(); pending = undefined; }
    else if (code[index] === ';') pending = undefined;
    if ('{};'.includes(code[index])) headerStart = index + 1;
  }
}
