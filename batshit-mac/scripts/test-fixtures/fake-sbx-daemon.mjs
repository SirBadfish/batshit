// A fake Docker `sbx` for tests of the sbx daemon stop (2026-09-21, BL-61). It keeps the rules
// measured against sbx v0.43.0: `ls --json` starts the daemon when it is not running and says
// `Starting sandboxd daemon...` on stderr first; `daemon status --json` never starts one and names
// the daemon's socket, beside which the daemon keeps `sandboxd.pid`; the daemon runs as
// `<bin>/sbx daemon start` (here behind node, the way a script shows in `ps`); `daemon stop` stops
// it. `sandboxes.json` in the fake's state folder is what `ls --json` lists.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FAKE_SBX = `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const state = process.env.FAKE_SBX_DAEMON_STATE
const socket = path.join(state, 'sandboxd', 'sandboxd.sock')
const pidFile = path.join(state, 'sandboxd', 'sandboxd.pid')
const sandboxesFile = path.join(state, 'sandboxes.json')
const [command, sub, flag] = process.argv.slice(2)
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const running = () => {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return 0
  }
}
fs.mkdirSync(path.dirname(pidFile), { recursive: true })
if (command === 'daemon' && sub === 'start') {
  fs.writeFileSync(pidFile, String(process.pid))
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
} else if (command === 'daemon' && sub === 'status' && flag === '--json') {
  console.log(JSON.stringify({ status: running() ? 'running' : 'stopped', socket }, null, 2))
} else if (command === 'daemon' && sub === 'stop') {
  const pid = running()
  if (!pid) {
    console.log('Daemon is not running')
    process.exit(0)
  }
  process.kill(pid, 'SIGTERM')
  for (let tries = 0; tries < 60; tries += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      console.log('Daemon stopped successfully')
      process.exit(0)
    }
    pause(50)
  }
  process.exit(1)
} else if (command === 'ls') {
  if (!running()) {
    process.stderr.write('Starting sandboxd daemon...\\n')
    const child = spawn(process.execPath, [__filename, 'daemon', 'start'], { detached: true, stdio: 'ignore' })
    child.unref()
    for (let tries = 0; tries < 60 && !running(); tries += 1) pause(50)
  }
  const sandboxes = fs.existsSync(sandboxesFile) ? JSON.parse(fs.readFileSync(sandboxesFile, 'utf8')) : []
  console.log(JSON.stringify({ sandboxes }, null, 2))
} else {
  process.stderr.write('fake sbx: unsupported ' + process.argv.slice(2).join(' ') + '\\n')
  process.exit(2)
}
`;

/** Install the fake under `root`; answers its path, its state folder, and the env it needs. */
export async function installFakeSbxDaemon(root) {
  const binDir = join(root, 'bin');
  const state = join(root, 'fake-sbx');
  await mkdir(binDir, { recursive: true });
  await mkdir(state, { recursive: true });
  const sbx = join(binDir, 'sbx');
  await writeFile(sbx, FAKE_SBX);
  await chmod(sbx, 0o755);
  return {
    sbx,
    binDir,
    state,
    env: { FAKE_SBX_DAEMON_STATE: state },
    async daemonPid() {
      return Number(await readFile(join(state, 'sandboxd', 'sandboxd.pid'), 'utf8').catch(() => '0'));
    },
    async setSandboxes(list) {
      await writeFile(join(state, 'sandboxes.json'), JSON.stringify(list));
    }
  };
}
