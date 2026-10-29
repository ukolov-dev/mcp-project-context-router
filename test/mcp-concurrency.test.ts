import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
it('keeps real MCP responsive during a stale-index rebuild and exposes full diagnostic data',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'mcp-concurrency-'));
  const write=(p:string,t:string)=>{mkdirSync(dirname(resolve(root,p)),{recursive:true});writeFileSync(resolve(root,p),t)};
  const record=(id:string)=>`---\nid: ${id}\ntype: note\nstatus: active\ntitle: ${id}\nmodules: [app]\nfiles: [missing.txt]\n---\nEvidence ${id}\n`;
  const client=new Client({name:'concurrency-test',version:'1'});
  try{
    execFileSync('git',['init','-q'],{cwd:root});
    write('.project-context/project.yaml','project:\n  name: Concurrent test\nmodules:\n  app:\n    path: src\ncommands: {}\n');
    for(let i=0;i<200;i++)write(`.project-context/active/notes/${i}.md`,record(`NOTE-${i}`));
    execFileSync(process.execPath,[resolve(packageRoot,'bin/project-context'),'index','--json'],{cwd:root,stdio:'pipe'});
    write('.project-context/active/notes/new.md',record('FreshStaleIndexToken'));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve(packageRoot,'bin/project-context-mcp')],cwd:root,
      env:{...process.env,PROJECT_CONTEXT_TOOL_PROFILE:'core'} as Record<string,string>,stderr:'pipe'}));
    const order:string[]=[];
    const pack=client.callTool({name:'build_context_pack',arguments:{query:'FreshStaleIndexToken',modules:['app'],maxTokens:6000}}).then(r=>{order.push('pack');return r});
    const second=client.callTool({name:'find_existing_capability',arguments:{query:'missingCapability',modules:['app']}});
    const brief=await client.callTool({name:'get_project_brief',arguments:{}});order.push('brief');
    expect(brief.isError).not.toBe(true);expect(order[0]).toBe('brief');
    const completed=await pack;expect(completed.isError).not.toBe(true);
    // This small fixture completes within the normal response window.
    expect((completed.structuredContent!.records as Array<{id:string}>).some(record=>record.id==='FreshStaleIndexToken')).toBe(true);
    expect((await second).isError).not.toBe(true);
    const doctor=await client.callTool({name:'context_doctor',arguments:{}});
    const data=doctor.structuredContent as Record<string,any>;
    expect(data.detail).toBe('summary');expect(doctor.content[0]).toMatchObject({type:'text'});
    expect(JSON.stringify(doctor.content).length).toBeLessThan(500);
    const full=await client.readResource({uri:data.fullResultUri});
    const snapshot=JSON.parse((full.contents[0] as {text:string}).text);
    expect(snapshot.status).toBe('COMPLETED');expect(snapshot.result.detail).toBeUndefined();
    const fullDetails=snapshot.result.diagnostics.find((d:any)=>d.id==='context-file-references');
    const compactDetails=data.diagnostics.find((d:any)=>d.id==='context-file-references');
    expect(fullDetails.details.length).toBeGreaterThan(compactDetails.details.length);
    const polled=await client.callTool({name:'get_operation_result',arguments:{operationId:data.operationId,detail:'full'}});
    expect(polled.structuredContent?.result).toEqual(snapshot.result);
    const health=JSON.parse(execFileSync(process.execPath,[resolve(packageRoot,'bin/project-context'),'index','--check','--json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    expect(health.fresh).toBe(true);
  } finally {await client.close();rmSync(root,{recursive:true,force:true});}
},20000);

it.skipIf(process.platform === 'win32')('returns RUNNING over real MCP and lets clients retrieve the same result after long work',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'mcp-pending-'));
  const client=new Client({name:'pending-test',version:'1'});
  const release=resolve(root,'release');
  try {
    execFileSync('git',['init','-q'],{cwd:root});
    mkdirSync(resolve(root,'.project-context'));mkdirSync(resolve(root,'fake-bin'));
    writeFileSync(resolve(root,'.project-context/project.yaml'),'project:\n  name: Pending Test\nmodules: {}\ncommands: {}\n');
    const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
    // Block only doctor's check-ignore subprocess, never MCP initialization or brief.
    writeFileSync(resolve(root,'fake-bin/git'),`#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if(process.argv[2]==='check-ignore'){
  writeFileSync(${JSON.stringify(resolve(root,'started'))},'started');
  const deadline=Date.now()+15000;
  while(!existsSync(${JSON.stringify(release)}) && Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
}
const child=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(child.status??1);
`,{mode:0o755});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve(packageRoot,'bin/project-context-mcp')],cwd:root,
      env:{...process.env,PATH:resolve(root,'fake-bin')+':'+process.env.PATH,PROJECT_CONTEXT_TOOL_PROFILE:'core'} as Record<string,string>,stderr:'pipe'}));
    const pending=client.callTool({name:'context_doctor',arguments:{}});
    await vi.waitFor(()=>expect(existsSync(resolve(root,'started'))).toBe(true),{timeout:6000});
    const brief=await client.callTool({name:'get_project_brief',arguments:{}});
    expect(brief.structuredContent?.project).toBe('Pending Test');
    const response=await pending;
    expect(response.structuredContent?.status).toBe('RUNNING');
    const operationId=response.structuredContent!.operationId;
    const stillRunning=await client.callTool({name:'get_operation_result',arguments:{operationId}});
    expect(stillRunning.structuredContent?.status).toBe('RUNNING');
    writeFileSync(release,'release');
    await vi.waitFor(async()=>{
      const result=await client.callTool({name:'get_operation_result',arguments:{operationId,detail:'full'}});
      expect(result.structuredContent?.status).toBe('COMPLETED');
      expect(result.structuredContent?.result).toHaveProperty('diagnostics');
    },{timeout:6000});
  } finally {writeFileSync(release,'release');await client.close();rmSync(root,{recursive:true,force:true});}
},20000);
