import { execFileSync } from 'node:child_process';
import fg from 'fast-glob';
import { loadProjectConfig } from '../storage/config.js';
import { sourceGlobsForModule, inferModulesFromPath, resolveModuleName } from '../storage/inference.js';
import { classifyFileReference } from '../storage/file-references.js';
import { repoPaths } from '../storage/repo.js';
import type { DoctorDiagnostic } from './doctor.js';

const ignored = ['**/.git/**', '**/node_modules/**', '**/build/**', '**/dist/**', '**/coverage/**', '**/target/**', '**/vendor/**', '**/archive/**', '**/.project-context/**'];

/** Inventory only: omitted files are never silently added to the capability index. */
export function checkSourceCoverage(): DoctorDiagnostic {
  const config = loadProjectConfig();
  const root = repoPaths().root;
  const covered = new Set(Object.values(config.modules).flatMap((module) => fg.sync(sourceGlobsForModule(module).map((glob) => glob.replaceAll('\\', '/')), { cwd: root, onlyFiles: true, followSymbolicLinks: false, ignore: ignored })));
  const files = fg.sync('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,java,kt,kts,go,rs,py,rb,php,cs,sql,yaml,yml}', { cwd: root, onlyFiles: true, dot: true, followSymbolicLinks: false, ignore: ignored });
  const missing = files.filter((file) => !covered.has(file) && classifyFileReference(file).kind === 'file');
  return { id: 'source-coverage', status: missing.length ? 'warn' : 'ok', message: missing.length ? `${missing.length} candidate source/config file(s) outside configured source_globs; review intentional exclusions before changing configuration.` : 'Candidate source/config files are covered by configured globs.', details: missing.slice(0, 30).map((file) => `${file}: ${inferModulesFromPath(file, config).join(', ') || 'no module mapping'}`) };
}

export function checkDurableMemory(): DoctorDiagnostic {
  try {
    const root = repoPaths().root;
    const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', '.project-context/active'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0'));
    const untracked = fg.sync('.project-context/active/**/*.md', { cwd: root, followSymbolicLinks: false }).filter((file) => !tracked.has(file));
    return { id: 'durable-memory', status: untracked.length ? 'warn' : 'ok', message: untracked.length ? `${untracked.length} durable record(s) are not tracked by Git and will not reach a new checkout. Review before staging; this check does not stage or commit.` : 'Active Markdown records are tracked locally; remote publication is not verified.', details: untracked.slice(0, 20) };
  } catch {
    return { id: 'durable-memory', status: 'warn', message: 'Git tracking could not be verified; configure durable record distribution explicitly.' };
  }
}

export function aliasSuggestions(names: string[]): string[] {
  const config = loadProjectConfig();
  const spelling = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '');
  return names.flatMap((name) => {
    const exact = resolveModuleName(name, config);
    if (exact) return exact === name ? [] : [`${name} -> ${exact} (configured alias; review record migration)`];
    const candidates = Object.keys(config.modules).filter((candidate) => spelling(candidate) === spelling(name));
    return candidates.map((candidate) => `${name} -> ${candidate} (suggestion only; add an alias after review)`);
  });
}
