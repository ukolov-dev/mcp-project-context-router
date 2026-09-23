import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { dump, load } from 'js-yaml';
import { contextCliCommand, loadProjectConfig } from '../storage/config.js';
import { classifyFileReference } from '../storage/file-references.js';
import { repoPaths } from '../storage/repo.js';

const hookMarker = '# PROJECT_CONTEXT managed pre-commit doctor hook';
const defaultHooksPath = '.githooks';

export type InstallGitHooksResult = {
  status: 'OK';
  hooksPath: string;
  hook: string;
  command: string;
  created: boolean;
  configured: boolean;
};

export function installGitHooks(): InstallGitHooksResult {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const hooksPath = config.contextRouter.gitHooksPath ?? defaultHooksPath;
  assertRepositoryRelativePath(hooksPath, 'Git hooks path');

  const hooksDirectory = resolve(paths.root, hooksPath);
  const hookPath = resolve(hooksDirectory, 'pre-commit');
  const relativeHookPath = relative(paths.root, hookPath).split(sep).join('/');
  const doctorCommand = contextCliCommand(config, 'doctor --commit --json');
  assertSingleLineCommand(doctorCommand);

  if (existsSync(hookPath)) {
    if (lstatSync(hookPath).isSymbolicLink()) {
      throw new Error(`${relativeHookPath} must not be a symbolic link.`);
    }
    const current = readFileSync(hookPath, 'utf8');
    if (!current.includes(hookMarker)) {
      throw new Error(`${relativeHookPath} already exists and is not managed by Project Context. Merge the doctor command manually.`);
    }
  }

  mkdirSync(hooksDirectory, { recursive: true });
  const created = !existsSync(hookPath);
  writeFileAtomic(hookPath, renderPreCommitHook(doctorCommand), 0o755);
  writeGitHookConfig(hooksPath, contextCliCommand(config, 'hooks install'));

  execFileSync('git', ['config', '--local', 'core.hooksPath', hooksPath], {
    cwd: paths.root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  return {
    status: 'OK',
    hooksPath,
    hook: relativeHookPath,
    command: doctorCommand,
    created,
    configured: true,
  };
}

function renderPreCommitHook(doctorCommand: string): string {
  return `#!/bin/sh
${hookMarker}
set -eu

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"
echo "[project-context] Validating mappings and file references before commit..."
${doctorCommand}
`;
}

function writeGitHookConfig(hooksPath: string, installCommand: string): void {
  const paths = repoPaths();
  const configPath = resolve(paths.contextDir, 'project.yaml');
  if (!existsSync(configPath)) throw new Error('Missing .project-context/project.yaml. Initialize Project Context first.');
  if (lstatSync(configPath).isSymbolicLink()) throw new Error('.project-context/project.yaml must not be a symbolic link.');

  const document = asObject(load(readFileSync(configPath, 'utf8')));
  const contextRouter = asObject(document.context_router);
  contextRouter.git_hooks_path = hooksPath;
  contextRouter.git_hooks_install_command = installCommand;
  document.context_router = contextRouter;
  writeFileAtomic(configPath, dump(document, { lineWidth: 120, noRefs: true, sortKeys: false }), statSync(configPath).mode & 0o777);
}

function writeFileAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function assertRepositoryRelativePath(path: string, label: string): void {
  const root = repoPaths().root;
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (!path.trim() || isAbsolute(path) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  if (classifyFileReference(path).kind === 'outside_repository') {
    throw new Error(`${label} must not escape the repository through a symbolic link.`);
  }
}

function assertSingleLineCommand(command: string): void {
  if (!command.trim() || /[\r\n\0]/.test(command)) {
    throw new Error('context_router.cli_command must be a non-empty single-line command before installing Git hooks.');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
