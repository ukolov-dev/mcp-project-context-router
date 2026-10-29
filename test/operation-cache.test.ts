import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withFileOperation, readOperationText, operationChecksum, realPath } from '../src/storage/operation.js';
import { classifyFileReference } from '../src/storage/file-references.js';
import { rebuildIndex } from '../src/indexer/sqlite.js';

let root: string, outside: string, previous: string;
beforeEach(() => {
  previous=process.cwd();root=mkdtempSync(resolve(tmpdir(),'router-operation-'));outside=mkdtempSync(resolve(tmpdir(),'router-external-'));
  mkdirSync(resolve(root,'.git'));mkdirSync(resolve(root,'.project-context'));
  writeFileSync(resolve(root,'.project-context/project.yaml'),'project:\n  name: Operation test\nmodules: {}\ncommands: {}\n');
  writeFileSync(resolve(root,'file.txt'),'original');writeFileSync(resolve(outside,'file.txt'),'external');process.chdir(root);
});
afterEach(() => { vi.restoreAllMocks();syncBuiltinESMExports();process.chdir(previous);rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true}); });

it('reads unchanged text and checksums once per operation and does not retain them between operations', () => {
  const path=resolve(root,'file.txt');
  const spy=vi.spyOn(fs,'readFileSync');syncBuiltinESMExports();
  withFileOperation(()=>{ for(let i=0;i<5;i++){expect(readOperationText(path)).toBe('original');operationChecksum(path);} });
  expect(spy.mock.calls.filter(c=>c[0]===path)).toHaveLength(2);
  withFileOperation(()=>readOperationText(path));
  expect(spy.mock.calls.filter(c=>c[0]===path)).toHaveLength(3);
});

it('invalidates cached values after content changes and file replacement within the same operation', () => {
  const path=resolve(root,'file.txt');
  withFileOperation(()=>{
    const initial=operationChecksum(path);expect(readOperationText(path)).toBe('original');
    writeFileSync(path,'changed length');
    expect(readOperationText(path)).toBe('changed length');expect(operationChecksum(path)).not.toBe(initial);
    writeFileSync(resolve(root,'replacement'),'replacement');renameSync(resolve(root,'replacement'),path);
    expect(readOperationText(path)).toBe('replacement');
    unlinkSync(path);expect(()=>readOperationText(path)).toThrow();
  });
});

it('revalidates symlink and junction boundaries on every reference, including missing children', () => {
  const link=resolve(root,'link');symlinkSync(root,link,process.platform==='win32'?'junction':'dir');
  withFileOperation(()=>{
    expect(classifyFileReference('link/file.txt').kind).toBe('file');
    expect(classifyFileReference('link/missing.txt').kind).toBe('missing');
    unlinkSync(link);symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
    expect(classifyFileReference('link/file.txt').kind).toBe('outside_repository');
    expect(classifyFileReference('link/missing.txt').kind).toBe('outside_repository');
    expect(classifyFileReference('../file.txt').kind).toBe('outside_repository');
    expect(classifyFileReference('C:\\external\\file.txt').kind).toBe('outside_repository');
  });
});

it('rechecks ordinary paths after they become links and preserves Unicode paths', () => {
  const directory=resolve(root,'каталог');mkdirSync(directory);writeFileSync(resolve(directory,'файл.txt'),'text');
  withFileOperation(()=>{
    expect(classifyFileReference('каталог/файл.txt').kind).toBe('file');
    rmSync(directory,{recursive:true});symlinkSync(outside,directory,process.platform==='win32'?'junction':'dir');
    expect(classifyFileReference('каталог/file.txt').kind).toBe('outside_repository');
  });
});

it('hashes a repeated source reference once during a real index rebuild', () => {
  mkdirSync('.project-context/active/backlog',{recursive:true});
  for(let i=0;i<10;i++)writeFileSync(`.project-context/active/backlog/${i}.md`,`---\nid: BACKLOG-PERF-${i}\ntype: backlog\nstatus: open\ntitle: Test\nfiles: [file.txt]\n---\nBody\n`);
  const path=fs.realpathSync(resolve(root,'file.txt'));const spy=vi.spyOn(fs,'readFileSync');syncBuiltinESMExports();
  rebuildIndex();expect(spy.mock.calls.filter(c=>c[0]===path)).toHaveLength(1);
});

it('discards operation caches after exceptions and shares them only with nested calls', () => {
  const path=resolve(root,'file.txt');const spy=vi.spyOn(fs,'readFileSync');syncBuiltinESMExports();
  expect(()=>withFileOperation(()=>{readOperationText(path);withFileOperation(()=>readOperationText(path));throw new Error('stop');})).toThrow('stop');
  withFileOperation(()=>readOperationText(path));
  expect(spy.mock.calls.filter(c=>c[0]===path)).toHaveLength(2);
});

it('falls back to standard realpath when native resolution is unavailable', () => {
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('native unavailable'); });
  expect(realPath(root)).toBe(fs.realpathSync(root));
});
