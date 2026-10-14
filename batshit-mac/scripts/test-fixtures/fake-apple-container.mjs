// A fake Apple `container` CLI for tests of the container system stop (2026-09-22, BL-62 part 2).
// It keeps the rules of container 0.12.3 (Sources/ContainerCommands/System/*.swift at tag 0.12.3,
// and the installed CLI): `system start` writes `<appRoot>/apiserver/apiserver.plist`, registers it
// (a `launchctl bootstrap` whose status Apple ignores, so a second start on a running system also
// succeeds and rewrites the plist), and answers; `system status --format json` prints `running`
// with the app root, or `unregistered` with exit 1; `system stop` stops EVERY container (the
// user's too) and then deregisters; `list --format json` lists running containers and
// `list --all --format json` all of them, as `{ status, configuration: { id, labels }, startedDate }`;
// `delete --force <id>...` deletes each one it has (a running one too), prints each id it deleted,
// and exits 1 naming any it does not have (ContainerDelete.swift). `calls.log` in the fake's state
// folder records every call, one line each.
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FAKE_CONTAINER = `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const state = process.env.FAKE_APPLE_CONTAINER_STATE
const appRoot = path.join(state, 'app-root') + '/'
const plist = path.join(appRoot, 'apiserver', 'apiserver.plist')
const registered = path.join(state, 'registered')
const containersFile = path.join(state, 'containers.json')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(state, 'calls.log'), args.join(' ') + '\\n')
if (fs.existsSync(path.join(state, 'hang'))) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  return
}
const key = args.join(' ')
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const containers = () => (fs.existsSync(containersFile) ? JSON.parse(fs.readFileSync(containersFile, 'utf8')) : [])
const status = (value) => JSON.stringify({ status: value, appRoot: value === 'running' ? appRoot : '', installRoot: value === 'running' ? '/usr/local/' : '', apiServerVersion: '', apiServerCommit: '', apiServerBuild: '', apiServerAppName: '' })
if (key === '--version') {
  console.log('container CLI version 0.12.3 (build: release, commit: fake)')
} else if (key === 'system start') {
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(plist, '<plist version="1.0"><dict><key>Label</key><string>com.apple.container.apiserver</string></dict></plist>\\n')
  console.log('Registering API server with launchd...')
  fs.writeFileSync(registered, '1')
  console.log('Verifying apiserver is running...')
} else if (key === 'system status --format json') {
  if (fs.existsSync(registered)) {
    console.log(status('running'))
  } else {
    console.log(status('unregistered'))
    process.exit(1)
  }
} else if (key === 'system stop') {
  if (fs.existsSync(path.join(state, 'stop-fails'))) process.exit(1)
  if (fs.existsSync(registered)) {
    const list = containers()
    const stopped = list.filter((entry) => entry.status === 'running').map((entry) => entry.configuration.id)
    if (stopped.length) fs.appendFileSync(path.join(state, 'stopped-containers.log'), stopped.join('\\n') + '\\n')
    fs.writeFileSync(containersFile, JSON.stringify(list.map((entry) => ({ ...entry, status: entry.status === 'running' ? 'stopped' : entry.status }))))
    fs.rmSync(registered, { force: true })
  }
} else if (key === 'list --all --format json' || key === 'list --format json') {
  if (fs.existsSync(path.join(state, 'list-fails'))) {
    // A failed call can still leave a plausible answer behind.
    console.log('[]')
    process.exit(1)
  }
  if (!fs.existsSync(registered)) {
    process.stderr.write('Error: apiserver is not running\\n')
    process.exit(1)
  }
  const all = containers()
  console.log(JSON.stringify(key.includes('--all') ? all : all.filter((entry) => entry.status === 'running')))
} else if (args[0] === 'delete' && args[1] === '--force' && args.length > 2) {
  const delayFile = path.join(state, 'delete-delay-ms')
  if (fs.existsSync(delayFile)) pause(Number(fs.readFileSync(delayFile, 'utf8')))
  if (fs.existsSync(path.join(state, 'delete-fails'))) {
    process.stderr.write('Error: internalError: "failed to delete one or more containers"\\n')
    process.exit(1)
  }
  if (!fs.existsSync(registered)) {
    process.stderr.write('Error: apiserver is not running\\n')
    process.exit(1)
  }
  const failsForFile = path.join(state, 'delete-fails-for')
  const failsFor = fs.existsSync(failsForFile) ? fs.readFileSync(failsForFile, 'utf8').split('\\n').filter(Boolean) : []
  let list = containers()
  const missing = []
  for (const id of args.slice(2)) {
    if (failsFor.includes(id) || !list.some((entry) => entry.configuration.id === id)) {
      missing.push(id)
      continue
    }
    list = list.filter((entry) => entry.configuration.id !== id)
    fs.writeFileSync(containersFile, JSON.stringify(list))
    fs.appendFileSync(path.join(state, 'deleted-containers.log'), id + '\\n')
    console.log(id)
  }
  if (missing.length) {
    process.stderr.write('Error: notFound: "container with ID ' + missing.join(', ') + ' not found"\\n')
    process.exit(1)
  }
} else {
  process.stderr.write('fake container: unsupported ' + key + '\\n')
  process.exit(2)
}
`;

/** Install the fake under `root`; answers its path, its state folder, the env it needs, and helpers. */
export async function installFakeAppleContainer(root) {
  const binDir = join(root, 'bin');
  const state = join(root, 'fake-apple-container');
  await mkdir(binDir, { recursive: true });
  await mkdir(state, { recursive: true });
  const container = join(binDir, 'container');
  await writeFile(container, FAKE_CONTAINER);
  await chmod(container, 0o755);
  const plist = join(state, 'app-root', 'apiserver', 'apiserver.plist');
  return {
    container,
    binDir,
    state,
    plist,
    env: { FAKE_APPLE_CONTAINER_STATE: state },
    async calls() {
      const text = await readFile(join(state, 'calls.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
    async clearCalls() {
      await writeFile(join(state, 'calls.log'), '');
    },
    /** Every container a `delete` removed, in order. */
    async deletedContainers() {
      const text = await readFile(join(state, 'deleted-containers.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
    /** Entries as `list --all --format json` prints them now. */
    async containers() {
      return JSON.parse(await readFile(join(state, 'containers.json'), 'utf8').catch(() => '[]'));
    },
    async stoppedContainers() {
      const text = await readFile(join(state, 'stopped-containers.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    },
    async registered() {
      return Boolean(await readFile(join(state, 'registered'), 'utf8').catch(() => ''));
    },
    /** Entries as `list --all --format json` prints them. */
    async setContainers(list) {
      await writeFile(join(state, 'containers.json'), JSON.stringify(list));
    },
    /** Pretend the registration happened at `ms` (the plist's mtime). */
    async setRegisteredAt(ms) {
      const at = new Date(ms);
      await utimes(plist, at, at);
    },
    /** A `container` that never answers and ignores SIGTERM. */
    async setHang(on) {
      await (on ? writeFile(join(state, 'hang'), '1') : rm(join(state, 'hang'), { force: true }));
    },
    /** A `container list` that exits 1 after printing `[]`. */
    async setListFails(on) {
      await (on ? writeFile(join(state, 'list-fails'), '1') : rm(join(state, 'list-fails'), { force: true }));
    },
    /** A `delete` that fails and deletes nothing. */
    async setDeleteFails(on) {
      await (on ? writeFile(join(state, 'delete-fails'), '1') : rm(join(state, 'delete-fails'), { force: true }));
    },
    /** A `delete` that fails for these ids (and still deletes the others), or null for none. */
    async setDeleteFailsFor(ids) {
      await (ids?.length
        ? writeFile(join(state, 'delete-fails-for'), `${ids.join('\n')}\n`)
        : rm(join(state, 'delete-fails-for'), { force: true }));
    },
    /** A `delete` that waits `ms` before it acts (0 or null: no wait). */
    async setDeleteDelay(ms) {
      await (ms ? writeFile(join(state, 'delete-delay-ms'), String(ms)) : rm(join(state, 'delete-delay-ms'), { force: true }));
    },
    /** A `system stop` that fails and leaves the system registered. */
    async setStopFails(on) {
      await (on ? writeFile(join(state, 'stop-fails'), '1') : rm(join(state, 'stop-fails'), { force: true }));
    },
    async reset() {
      for (const name of ['registered', 'containers.json', 'calls.log', 'stopped-containers.log', 'deleted-containers.log', 'hang', 'stop-fails', 'list-fails', 'delete-fails', 'delete-fails-for', 'delete-delay-ms']) {
        await rm(join(state, name), { force: true });
      }
      await rm(join(state, 'app-root'), { recursive: true, force: true });
    }
  };
}
