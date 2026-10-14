import { spawn } from 'node:child_process';

// One owned service child. A terminal hangup requests its graceful stop; it is not
// forwarded as HUP (Redis ignores HUP). INT/TERM and await-child behavior stay intact.
export function startChild(service, { command, args, cwd, env }, stdio) {
  const child = spawn(command, args, { cwd, env, stdio });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal));
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.log(`Error: could not start the ${service}: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
  });
  return { child, exited };
}
