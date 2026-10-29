import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpOperations } from '../src/mcp/operations.js';
import { compactLint, compactDoctor } from '../src/diagnostics/compact.js';
let root: string, operations: McpOperations;
beforeEach(() => {
  root=mkdtempSync(resolve(tmpdir(),'mcp-worker-test-'));
  writeFileSync(resolve(root,'worker.mjs'), `import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({id,tool,args})=>{
      if(tool==='crash') process.exit(7);
      if(tool==='hold') Atomics.wait(new Int32Array(args.gate),0,0);
      parentPort.postMessage({id,result:{content:[],structuredContent:{tool}}});
    });`);
  operations=new McpOperations(pathToFileURL(resolve(root,'worker.mjs')),10);
});
afterEach(async()=>{await operations.close();rmSync(root,{recursive:true,force:true});});
it('returns RUNNING for slow work, serves status immediately, and completes queued requests in order', async()=>{
  const gate=new SharedArrayBuffer(4);
  const first=await operations.execute('hold',{gate});
  expect(first.status).toBe('RUNNING');
  const second=await operations.execute('next',{});
  expect(second.status).toBe('RUNNING');
  expect(operations.get(first.operationId).status).toBe('RUNNING');
  Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
  await vi.waitFor(()=>expect(operations.get(second.operationId).status).toBe('COMPLETED'));
  expect(operations.get(first.operationId).status).toBe('COMPLETED');
  expect(operations.get('absent').status).toBe('NOT_FOUND');
});
it('bounds pending work instead of starting duplicate workers',async()=>{
  const gate=new SharedArrayBuffer(4);
  const requests=await Promise.all(Array.from({length:8},()=>operations.execute('hold',{gate})));
  expect(requests.every(r=>r.status==='RUNNING')).toBe(true);
  await expect(operations.execute('extra',{})).rejects.toThrow('queue is full');
  Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
  await vi.waitFor(()=>expect(operations.get(requests[7].operationId).status).toBe('COMPLETED'));
});
it('marks pending operations FAILED after worker exit without retrying them',async()=>{
  const first=await operations.execute('crash',{});
  await vi.waitFor(()=>expect(operations.get(first.operationId).status).toBe('FAILED'));
  expect(JSON.stringify(operations.get(first.operationId))).toContain('not retried');
  const second=await operations.execute('new',{});
  await vi.waitFor(()=>expect(operations.get(second.operationId).status).toBe('COMPLETED'));
});
it('compacts repeated diagnostics without modifying the full result or losing counts',()=>{
  const warnings=Array.from({length:1000},(_,i)=>`Warning ${i} ${'x'.repeat(1000)}`);
  const result={errors:[],warnings,categories:{active:warnings,historical:[],draft:[]}};
  const compact=compactLint(result);
  expect(compact.counts.warnings).toBe(1000);expect(compact.counts.categories.active).toBe(1000);
  expect(JSON.stringify(compact).length).toBeLessThan(2000);expect(result.warnings).toHaveLength(1000);
  const doctor=compactDoctor({status:'WARN',summary:{ok:0,warn:1,fail:0},diagnostics:[{id:'lint',status:'warn',message:'Warnings',details:warnings}]});
  expect(doctor.diagnostics[0]).toMatchObject({detailCount:1000,details:expect.any(Array)});
  expect(doctor.diagnostics[0].details).toHaveLength(3);
});
