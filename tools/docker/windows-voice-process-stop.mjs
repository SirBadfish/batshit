import { localRuntimeProcessTreeFromWindows } from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs'

export function sameWindowsProcess(processes, member) {
  return processes.some((entry) => entry.pid === member.pid && entry.startedAtMs === member.startedAtMs)
}

function memberKey(member) {
  return `${member.pid}:${member.startedAtMs}`
}

export function validWindowsMembers(value) {
  return Array.isArray(value)
    ? value.filter((member) => Number.isInteger(member?.pid) && member.pid > 0 && Number.isFinite(member.startedAtMs))
    : []
}

// The first process-table read happens after spawn. Its PID may already have
// been reused, so only a root born by the synchronous spawn timestamp belongs
// to this launch. Ambiguous children do not invalidate the known members.
export function windowsMembersAtLaunch(tree, launchedAtMs) {
  if (!tree || !Number.isFinite(tree.leaderStartedAtMs) ||
      !Number.isFinite(launchedAtMs) || tree.leaderStartedAtMs > launchedAtMs) return []
  return validWindowsMembers(tree.members).map(({ pid, startedAtMs }) => ({ pid, startedAtMs }))
}

// Only verified identities are killed. An exited parent can leave descendants whose
// parent link is no longer recoverable; known descendants are persisted in launch
// records. Windows Job Objects would close the remaining gap for unseen orphans.
export async function stopWindowsVoiceProcessTree({
  rootPid,
  knownMembers,
  initialProcesses,
  readProcesses,
  killProcess,
  persistMembers,
  settleMs = 200
}) {
  const tracked = []
  const ids = new Set()
  let dirty = false
  const add = (member) => {
    const key = memberKey(member)
    if (!ids.has(key)) {
      ids.add(key)
      tracked.push({ pid: member.pid, startedAtMs: member.startedAtMs })
      dirty = true
      return true
    }
    return false
  }
  for (const member of validWindowsMembers(knownMembers)) add(member)
  dirty = false
  let processes = initialProcesses ?? await readProcesses()
  if (processes === null) return { ok: false, reason: 'the Windows process table could not be read', members: tracked }
  if (!tracked.length) return { ok: false, reason: 'no process identity was recorded at launch', members: tracked }

  const observe = async () => {
    let uncertainty = null
    for (let index = 0; index < tracked.length; index += 1) {
      const member = tracked[index]
      if (!sameWindowsProcess(processes, member)) {
        if (processes.some((entry) =>
          entry.parentPid === member.pid &&
          (!Number.isFinite(entry.startedAtMs) || entry.startedAtMs >= member.startedAtMs) &&
          !ids.has(memberKey(entry))
        )) uncertainty ??= 'a child appeared after its parent exited; its identity is ambiguous'
        continue
      }
      const tree = localRuntimeProcessTreeFromWindows(processes, member.pid)
      if (!tree || tree.leaderStartedAtMs !== member.startedAtMs) {
        uncertainty ??= `pid ${member.pid} changed identity`
        continue
      }
      if (tree.unsafeDescendants) uncertainty ??= `pid ${member.pid} has an ambiguous child`
      for (const child of tree.members) add(child)
    }
    const persisted = dirty
    if (dirty) {
      await persistMembers(tracked)
      dirty = false
    }
    return { uncertainty, persisted }
  }
  let observed = await observe()
  let uncertainty = observed.uncertainty
  if (!tracked.some((member) => sameWindowsProcess(processes, member))) {
    return uncertainty
      ? { ok: false, reason: uncertainty, members: tracked }
      : { ok: true, wasNotRunning: true, members: tracked }
  }

  // Each kill holds and checks the process identity at the kill site. A table read
  // after persistence catches relationships that changed while the record lock waited.
  for (let index = 0; index < tracked.length; index += 1) {
    processes = await readProcesses()
    if (processes === null) return { ok: false, reason: 'the Windows process table could not be read before force', members: tracked }
    observed = await observe()
    uncertainty ??= observed.uncertainty
    if (observed.persisted) {
      processes = await readProcesses()
      if (processes === null) return { ok: false, reason: 'the Windows process table could not be read after recording children', members: tracked }
    }
    const member = tracked[index]
    if (sameWindowsProcess(processes, member)) {
      const outcome = await killProcess(member.pid, member.startedAtMs)
      if (outcome && outcome !== 'killed' && outcome !== 'gone') {
        uncertainty ??= `pid ${member.pid} could not be stopped with its recorded identity: ${outcome}`
      }
    }
  }
  if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs))
  processes = await readProcesses()
  if (processes === null) return { ok: false, reason: 'the Windows process table could not be read after force', members: tracked }
  observed = await observe()
  uncertainty ??= observed.uncertainty
  if (tracked.some((member) => sameWindowsProcess(processes, member))) {
    return { ok: false, reason: 'the verified Windows process members remained alive after Process.Kill', members: tracked }
  }
  return uncertainty ? { ok: false, reason: uncertainty, members: tracked } : { ok: true, members: tracked }
}
