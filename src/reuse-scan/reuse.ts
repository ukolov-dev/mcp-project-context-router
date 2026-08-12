import { searchCapabilities } from '../indexer/sqlite.js';
import { discoverCapabilities } from '../indexer/capabilities.js';
import { inferModulesFromQuery } from '../storage/inference.js';

export type ReuseScanResult = {
  matches: Array<{
    path: string;
    kind: string;
    name: string;
    classification: 'direct_reuse' | 'copy_local_pattern' | 'do_not_reuse_due_to_mismatch' | 'create_shared_abstraction' | 'ask_before_broad_refactor';
    reason: string;
  }>;
  recommendation: string;
};

export type BatchReuseScanInput = {
  queries: Array<{
    query: string;
    modules?: string[];
  }>;
};

export type BatchReuseScanResult = {
  results: Array<{
    query: string;
    modules: string[];
    result: ReuseScanResult;
  }>;
};

export function findExistingCapability(query: string, modules = inferModulesFromQuery(query)): ReuseScanResult {
  try {
    const matches = searchCapabilities(query, modules).map((row) => ({
      path: row.path,
      kind: row.kind,
      name: row.name,
      classification: classify(row.kind, row.path, query),
      reason: `Indexed ${row.kind} in ${row.module} matches query terms.`,
    }));
    return {
      matches,
      recommendation:
        matches.length > 0
          ? 'Review existing capabilities before creating new components, hooks, DTOs, mappers, services, policies, utilities, or test helpers.'
          : 'No close indexed capability found; creating local feature code is acceptable if code inspection confirms no match.',
    };
  } catch {
    const matches = fallbackCapabilities(query, modules).map((row) => ({
      path: row.path,
      kind: row.kind,
      name: row.name,
      classification: classify(row.kind, row.path, query),
      reason: `Source scan ${row.kind} in ${row.module} matches query terms.`,
    }));
    return {
      matches,
      recommendation:
        matches.length > 0
          ? 'Index unavailable; source scan found potential matches. Rebuild the index for better ranking.'
          : 'Index unavailable and source scan found no close capability.',
    };
  }
}

export function findExistingCapabilities(input: BatchReuseScanInput): BatchReuseScanResult {
  return {
    results: input.queries.map((request) => {
      const modules = request.modules ?? inferModulesFromQuery(request.query);
      return {
        query: request.query,
        modules,
        result: findExistingCapability(request.query, modules),
      };
    }),
  };
}

function fallbackCapabilities(query: string, modules: string[]) {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length > 3)
    .slice(0, 8);
  const capabilities = discoverCapabilities().capabilities;
  return capabilities
    .filter((capability) => modules.includes(capability.module ?? ''))
    .filter((capability) => {
      const haystack = `${capability.name} ${capability.kind} ${capability.filePath} ${capability.signature ?? ''}`.toLowerCase();
      return words.some((word) => haystack.includes(word));
    })
    .slice(0, 12)
    .map((capability) => ({
      name: capability.name,
      kind: capability.kind,
      path: capability.filePath,
      module: capability.module ?? 'unknown',
    }));
}

function classify(kind: string, path: string, query: string): ReuseScanResult['matches'][number]['classification'] {
  if (/shared/.test(path) && /helper|util|builder|hook|component/i.test(kind)) return 'direct_reuse';
  if (/shared|public api|общ/i.test(query)) return 'ask_before_broad_refactor';
  if (/test|builder/i.test(path)) return 'copy_local_pattern';
  return 'copy_local_pattern';
}
