import { z } from 'zod';
import { ensureFreshIndex, openDb } from '../indexer/sqlite.js';

const symbol = z.string().trim().min(1).max(500);
export const explainInputSchema = z.object({ symbol, limit: z.number().int().min(1).max(200).default(50) });
export const affectedInputSchema = explainInputSchema.extend({ depth: z.number().int().min(1).max(8).default(2) });
export const pathInputSchema = z.object({ from: symbol, to: symbol, depth: z.number().int().min(1).max(20).default(8) });
type SymbolNode = { id: string; name: string; kind: string; file: string; line: number | null; endLine: number | null };
type Edge = { source: string; target: string; relation: string; file: string; line: number };

function readGraph() {
  ensureFreshIndex({ force: true });
  const db = openDb();
  try {
    const nodes = db.prepare('SELECT id, name, kind, file_path AS file, line_start AS line, line_end AS endLine FROM symbols WHERE graph_node = 1 ORDER BY file_path, line_start, id').all() as SymbolNode[];
    const edges = db.prepare('SELECT source_id AS source, target_id AS target, relation_type AS relation, file_path AS file, line FROM symbol_relations ORDER BY file_path, line, source_id, target_id').all() as Edge[];
    const coverage = JSON.parse((db.prepare("SELECT value FROM index_metadata WHERE key = 'symbol_graph_coverage'").get() as { value: string }).value) as unknown;
    return { nodes, edges, coverage };
  } finally { db.close(); }
}

function resolveSymbol(nodes: SymbolNode[], query: string) {
  const exact = nodes.find(n => n.id === query);
  if (exact) return [exact];
  const separator = query.lastIndexOf('#');
  return nodes.filter(n => separator < 0 ? n.name === query : n.file === query.slice(0, separator) && n.name === query.slice(separator + 1));
}

function unresolved(matches: SymbolNode[]) {
  return { status: matches.length ? 'ambiguous' : 'not_found', candidates: matches.slice(0, 50), truncated: matches.length > 50 };
}

export function explainSymbol(input: z.input<typeof explainInputSchema>) {
  const { symbol, limit } = explainInputSchema.parse(input);
  const graph = readGraph();
  const matches = resolveSymbol(graph.nodes, symbol);
  if (matches.length !== 1) return { ...unresolved(matches), coverage: graph.coverage };
  const selected = matches[0];
  const connections = graph.edges.filter(e => e.source === selected.id || e.target === selected.id);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return { status: 'found', symbol: selected, coverage: graph.coverage, truncated: connections.length > limit,
    connections: connections.slice(0, limit).map(e => ({ ...e, confidence: 'EXTRACTED', source: byId.get(e.source), target: byId.get(e.target) })) };
}

export function affectedSymbols(input: z.input<typeof affectedInputSchema>) {
  const { symbol, depth, limit } = affectedInputSchema.parse(input);
  const graph = readGraph();
  const matches = resolveSymbol(graph.nodes, symbol);
  if (matches.length !== 1) return { ...unresolved(matches), coverage: graph.coverage };
  const incoming = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.target) ?? []; list.push(edge); incoming.set(edge.target, list);
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const queue = [{ id: matches[0].id, depth: 0 }];
  const seen = new Set([matches[0].id]);
  const affected: Array<{ symbol: SymbolNode; depth: number; via: Edge }> = [];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const edge of incoming.get(current.id) ?? []) {
      if (seen.has(edge.source)) continue;
      if (current.depth === depth || affected.length === limit) { truncated = true; continue; }
      seen.add(edge.source);
      affected.push({ symbol: byId.get(edge.source)!, depth: current.depth + 1, via: edge });
      queue.push({ id: edge.source, depth: current.depth + 1 });
    }
  }
  return { status: 'found', symbol: matches[0], coverage: graph.coverage, affected, truncated };
}

export function symbolPath(input: z.input<typeof pathInputSchema>) {
  const { from, to, depth } = pathInputSchema.parse(input);
  const graph = readGraph();
  const starts = resolveSymbol(graph.nodes, from), ends = resolveSymbol(graph.nodes, to);
  if (starts.length !== 1) return { ...unresolved(starts), endpoint: 'from', coverage: graph.coverage };
  if (ends.length !== 1) return { ...unresolved(ends), endpoint: 'to', coverage: graph.coverage };
  const outgoing = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? []; list.push(edge); outgoing.set(edge.source, list);
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const queue = [{ id: starts[0].id, depth: 0 }];
  const seen = new Set([starts[0].id]);
  const parents = new Map<string, Edge>();
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.id === ends[0].id) {
      const edges: Edge[] = [];
      let id = current.id;
      while (parents.has(id)) { const edge = parents.get(id)!; edges.unshift(edge); id = edge.source; }
      return { status: 'found', coverage: graph.coverage, nodes: [starts[0], ...edges.map(e => byId.get(e.target)!)], edges, truncated: false };
    }
    for (const edge of outgoing.get(current.id) ?? []) {
      if (seen.has(edge.target)) continue;
      if (current.depth === depth || seen.size >= 5000) { truncated = true; continue; }
      seen.add(edge.target); parents.set(edge.target, edge);
      queue.push({ id: edge.target, depth: current.depth + 1 });
    }
  }
  return { status: truncated ? 'truncated' : 'no_path', coverage: graph.coverage, nodes: [], edges: [], truncated };
}
