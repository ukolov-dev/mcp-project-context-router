import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type Operation = { operationId: string; tool: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED'; result?: CallToolResult; error?: string };

/** One serial worker preserves write ordering while keeping the MCP transport responsive. */
export class McpOperations {
  private worker?: Worker;
  private jobs = new Map<string, { operation: Operation; done: Promise<Operation>; finish: (value: Operation) => void }>();
  constructor(private entrypoint = new URL('./server.js', import.meta.url), private waitMs = 5000) {}

  async execute(tool: string, args: unknown): Promise<Operation> {
    if ([...this.jobs.values()].filter(j => j.operation.status === 'RUNNING').length >= 8) {
      throw new Error('MCP worker queue is full; poll existing operations before submitting more work.');
    }
    this.prune();
    const operation: Operation = { operationId: randomUUID(), tool, status: 'RUNNING' };
    let finish!: (value: Operation) => void;
    const done = new Promise<Operation>(resolve => { finish = resolve; });
    this.jobs.set(operation.operationId, { operation, done, finish });
    try { this.getWorker().postMessage({ id: operation.operationId, tool, args }); }
    catch (error) { this.complete(operation.operationId, undefined, String(error)); }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([done, new Promise<Operation>(resolve => { timer = setTimeout(() => resolve(operation), this.waitMs); })]);
    } finally { clearTimeout(timer); }
  }

  get(id: string): Operation | { operationId: string; status: 'NOT_FOUND' } {
    return this.jobs.get(id)?.operation ?? { operationId: id, status: 'NOT_FOUND' };
  }

  async close(): Promise<void> {
    if (this.worker) await this.worker.terminate();
  }

  private prune() {
    // Results are session-local and bounded; pending work is never evicted.
    const completed = [...this.jobs].filter(([, j]) => j.operation.status !== 'RUNNING');
    for (const [id] of completed.slice(0, Math.max(0, this.jobs.size - 24))) this.jobs.delete(id);
  }

  private complete(id: string, result?: CallToolResult, error?: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job.operation, { status: error ? 'FAILED' : 'COMPLETED', result, error });
    job.finish(job.operation);
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.entrypoint, { stdout: true, stderr: true });
    worker.unref();
    worker.stdout.on('data', chunk => process.stderr.write(chunk));
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    worker.on('message', ({ id, result, error }) => this.complete(id, result, error));
    const fail = (message: string) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const [id, job] of this.jobs) if (job.operation.status === 'RUNNING') this.complete(id, undefined, message);
    };
    worker.on('error', error => fail(error instanceof Error ? error.message : String(error)));
    worker.on('exit', code => fail(`MCP worker exited (${code}); operation was not retried.`));
    this.worker = worker;
    return worker;
  }
}
