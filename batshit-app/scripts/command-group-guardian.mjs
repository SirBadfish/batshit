// This process is the ownership anchor, not the command. Only it may signal its group.
// No control endpoint or token is inherited by the executable it starts.
import { spawn } from 'node:child_process'
import { closeSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'

const GRACE_MS = 400
let token = null
let state = 'starting'
let child = null
let commandFinished = false
let scanTimer = null
let scanning = false
let verifiedGroup = false
let warnedScan = false
let configuration = null

function send(type, fields = {}) {
  if (process.connected) process.send({ version: 1, token, type, ...fields }, () => {})
}

function finishCommand(code, signal) {
  if (commandFinished) return
  commandFinished = true
  send('command-exit', { code, signal })
  if (state === 'active') void scanForRetirement()
}

function end() {
  // Idle is irreversible: even a previously queued end/EOF cannot signal after idle.
  if (state === 'idle' || state === 'retired') {
    state = 'retired'
    process.exit(0)
  }
  if (state === 'ending') return
  state = 'ending'
  clearTimeout(scanTimer)
  if (!child) finishCommand(null, 'SIGTERM')
  if (!verifiedGroup) return process.exit(0)
  process.kill(0, 'SIGTERM')
  // The guardian ignores TERM and stays the group leader until this call kills it too.
  setTimeout(() => process.kill(0, 'SIGKILL'), GRACE_MS)
}

// Installed before readiness or command launch. A disconnected parent cannot leave ownership
// available to a later process which happens to receive the same numeric PID.
process.on('SIGTERM', () => {})
process.on('SIGINT', end)
process.on('disconnect', end)

async function linuxSnapshot() {
  const deadline = Date.now() + 2_000
  const entries = (await readdir('/proc')).filter(name => /^\d+$/.test(name))
  const rows = []
  for (let offset = 0; offset < entries.length; offset += 64) {
    if (Date.now() > deadline) throw new Error('Process group scan timed out')
    const batch = await Promise.all(entries.slice(offset, offset + 64).map(async pid => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        const end = stat.lastIndexOf(')')
        const fields = stat.slice(end + 2).trim().split(/\s+/)
        if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2])) throw new Error('Malformed process identity')
        return { pid: Number(pid), parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[0] === 'Z' }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
        throw error
      }
    }))
    rows.push(...batch.filter(Boolean))
  }
  if (!rows.some(row => row.pid === process.pid && row.group === process.pid && !row.zombie)) throw new Error('Guardian is not the live leader of its own group')
  return rows
}

function groupSnapshot() {
  // Docker's slim runtime deliberately does not depend on procps.
  if (process.platform === 'linux') return linuxSnapshot()
  if (process.platform !== 'darwin') return Promise.reject(new Error('Unsupported command guardian platform'))
  return new Promise((resolve, reject) => {
    // The inspection process has its own group; otherwise its snapshot would always count
    // itself as another member. A failed/truncated/malformed scan is never an empty group.
    const probe = spawn('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let bytes = 0
    let failure = null
    const timer = setTimeout(() => {
      failure = new Error('Process group scan timed out')
      probe.kill('SIGKILL')
    }, 2_000)
    probe.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) {
        failure = new Error('Process group scan exceeded its output bound')
        probe.kill('SIGKILL')
      } else stdout += chunk.toString()
    })
    probe.stderr.resume()
    probe.once('error', error => { failure = error })
    probe.once('close', (code, signal) => {
      clearTimeout(timer)
      if (failure || code !== 0 || signal) return reject(failure ?? new Error('Process group scan failed'))
      const rows = []
      for (const line of stdout.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
        if (!match) return reject(new Error('Malformed process group scan'))
        rows.push({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), zombie: match[4].startsWith('Z') })
      }
      if (!rows.some(row => row.pid === process.pid && row.group === process.pid && !row.zombie)) {
        return reject(new Error('Guardian is not the live leader of its own group'))
      }
      // The completed scanner is our own short-lived child, not an escaped command.
      resolve(rows.filter(row => row.pid !== probe.pid))
    })
  })
}

async function scanForRetirement() {
  if (state !== 'active' || !commandFinished || scanning) return
  scanning = true
  try {
    const rows = await groupSnapshot()
    if (state !== 'active') return
    if (!rows.some(row => row.group === process.pid && row.pid !== process.pid && !row.zombie)) {
      const escaped = rows.filter(row => row.parent === process.pid && row.group !== process.pid && !row.zombie)
      if (escaped.length) send('warning', { message: 'A live child left the command group; group cleanup cannot end it.', pids: escaped.map(row => row.pid) })
      // This establishes membership only AT THE SCAN. Escaped/rejoining descendants are the separate escape-class follow-up.
      // Freeze signals before asking the parent to remove its exact token, then wait for retire.
      state = 'idle'
      send('idle')
      return
    }
  } catch (error) {
    if (!warnedScan) send('warning', { message: `Cannot verify command group retirement: ${error.message}` })
    warnedScan = true
  } finally {
    scanning = false
    if (state === 'active') scanTimer = setTimeout(scanForRetirement, 1_000)
  }
}

async function initialize(message) {
  token = message.token
  configuration = message
  try {
    await groupSnapshot()
    verifiedGroup = true
    if (state !== 'starting') return end()
    state = 'ready'
    send('ready', { guardianPid: process.pid })
  } catch (error) {
    send('failure', { message: `Command guardian could not start: ${error.message}` })
    end()
  }
}

function start() {
  if (state !== 'ready') return
  state = 'active'
  const message = configuration
  configuration = null
  try {
    child = spawn(message.executable, message.args, {
      cwd: message.cwd, env: message.env, shell: false, detached: false,
      // Inherit ONLY these descriptors. The guardian's IPC channel is not among them.
      stdio: ['ignore', 4, 5]
    })
    child.once('spawn', () => {
      send('command-started', { pid: child.pid })
      // The app owns the read ends; command descendants may keep the write ends, exactly as
      // with a direct spawn. The guardian must not keep command output artificially open.
      // fd 1 and 2 stay valid in the guardian. Closing both standard descriptors
      // makes the nvm Node 24.12 build abort when a later group scan spawns ps.
      // These dedicated output descriptors carry only the command's streams.
      closeSync(4)
      closeSync(5)
    })
    child.once('error', error => {
      send('spawn-error', { message: error.message, code: error.code })
      try { closeSync(4) } catch {}
      try { closeSync(5) } catch {}
      finishCommand(null, null)
    })
    child.once('exit', finishCommand)
  } catch (error) {
    send('failure', { message: `Command guardian could not start: ${error.message}` })
    end()
  }
}

const startupTimer = setTimeout(() => {
  send('failure', { message: 'Command guardian initialization timed out.' })
  end()
}, 5_000)

process.on('message', message => {
  if (!message || message.version !== 1 || typeof message.token !== 'string') return
  if (token === null && state === 'starting' && message.type === 'init') {
    if (!/^[a-f0-9-]{36}$/.test(message.token) || typeof message.executable !== 'string' || !Array.isArray(message.args) || !message.args.every(value => typeof value === 'string') || !message.env || typeof message.env !== 'object') return
    clearTimeout(startupTimer)
    void initialize(message)
    return
  }
  if (message.token !== token) return
  if (message.type === 'start') start()
  if (message.type === 'end') end()
  if (message.type === 'retire' && state === 'idle') {
    state = 'retired'
    process.exit(0)
  }
})
