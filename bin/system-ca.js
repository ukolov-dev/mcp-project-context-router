import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const systemCaFlag = '--use-system-ca';

export function systemCaNodeArgs(args, options = {}) {
  const allowedFlags = options.allowedNodeEnvironmentFlags ?? process.allowedNodeEnvironmentFlags;
  const execArgv = options.execArgv ?? process.execArgv;
  const nodeOptions = options.nodeOptions ?? process.env.NODE_OPTIONS ?? '';
  const supported = allowedFlags?.has(systemCaFlag) === true;
  const alreadyEnabled = execArgv.includes(systemCaFlag)
    || /(?:^|\s)--use-system-ca(?:\s|$)/.test(nodeOptions);
  return supported && !alreadyEnabled ? [systemCaFlag, ...args] : [...args];
}

export async function runEntrypointWithSystemCa(entrypoint, args = process.argv.slice(2)) {
  const childArgs = systemCaNodeArgs([entrypoint, ...args]);
  if (childArgs[0] !== systemCaFlag) {
    await import(entrypoint);
    return;
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    try {
      process.once(signal, handler);
      handlers.set(signal, handler);
    } catch {
      // Some signals are unavailable on some platforms.
    }
  }

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  });

  if (result.code !== null) {
    process.exitCode = result.code;
    return;
  }
  process.exitCode = 128 + (constants.signals[result.signal] ?? 0);
}
