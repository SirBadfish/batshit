/**
 * BL-1483: the text the model reads, inside a reply, for one `native_bash_execute` result on the
 * API lane.
 *
 * The tool's `toModelOutput` used to return the whole result object as JSON, which
 * `toReadableToolModelOutput` (`vercelBrain.ts`) pretty-prints: every field on its own line, the
 * command three times, and stdout JSON-escaped. Measured on the SA-126 B0 chats, that cost about
 * 326 extra tokens per call plus 1.3 to 1.6 times the output itself, re-sent on every later request
 * of the same reply. This text keeps every fact the prompts and the native Bash guidance rely on
 * (`success:false`, `blocked:true`, `POLICY_BLOCKED` and the other error codes, the exit code, the
 * signal, `timedOut`, `stopped` and its reason, `truncated`, the shell, a managed apply_patch's
 * files, an edit's diff, and every Agent Browser fact) and drops what the model already has or does
 * not use: the command (the call shows it), the access and policy modes (the DCM's `native_bash`
 * line), the backend, the working folder and workspace root, the renderer mapping, the duration,
 * and every false or null default.
 *
 * Only the model's view changes. The result object itself is what the card, the zip, the stored
 * steps and the Execution Viewer keep, unchanged (zips are persistence). A result at or over the
 * in-turn guard (25,000 tokens) still reaches the model through the command capture (BL-679) or
 * `guardReadableToolModelOutput`, which this text passes through like any other.
 *
 * No imports, so the offline measurement can load this file directly.
 */

type BashResult = Record<string, unknown>

/** A result object the Bash tool built: it always says whether it succeeded. */
export function isBashResultForModel(output: unknown): output is BashResult {
  return Boolean(output) && typeof output === 'object' && !Array.isArray(output) &&
    typeof (output as BashResult).success === 'boolean'
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function formatBashResultForModel(output: BashResult): string {
  const status = [`success:${output.success === true}`]
  if (output.blocked === true) status.push('blocked:true')
  if (text(output.errorCode)) status.push(`errorCode:${text(output.errorCode)}`)
  if (typeof output.exitCode === 'number') status.push(`exitCode:${output.exitCode}`)
  if (text(output.signal)) status.push(`signal:${text(output.signal)}`)
  if (output.timedOut === true) status.push('timedOut:true')
  if (output.stopped === true) status.push('stopped:true')
  if (output.truncated === true) status.push('truncated:true')

  const lines = [status.join('; ')]
  const reason = text(output.reason)
  const error = text(output.error)
  if (reason) lines.push(`reason: ${reason}`)
  if (error && error !== reason) lines.push(`error: ${error}`)
  if (text(output.shell)) lines.push(`shell: ${text(output.shell)}`)

  const patch = output.managedApplyPatch
  if (patch && typeof patch === 'object') {
    const { operationsApplied, touchedPaths, partial, changedPaths } = patch as {
      operationsApplied?: unknown
      touchedPaths?: unknown
      partial?: unknown
      changedPaths?: unknown
    }
    if (partial === true) {
      // BL-1916: a write failed and Batshit could not put every path back; `reason` says which.
      const changed = Array.isArray(changedPaths) ? changedPaths.filter((path) => typeof path === 'string') : []
      lines.push(`apply_patch: partly written; left changed: ${changed.join(', ')}`)
    } else {
      const files = Array.isArray(touchedPaths) ? touchedPaths.filter((path) => typeof path === 'string') : []
      const count = typeof operationsApplied === 'number' ? operationsApplied : files.length
      lines.push(`apply_patch: ${count} operation${count === 1 ? '' : 's'}${files.length > 0 ? `; files: ${files.join(', ')}` : ''}`)
      const { note, afterPatch, afterPatchStarted } = patch as { note?: unknown; afterPatch?: unknown; afterPatchStarted?: unknown }
      if (text(note)) lines.push(`apply_patch note: ${text(note)}`)
      // SA-126 item 2: the commands after the patch ran after it applied; the status above, the
      // exit code and the output are theirs, and the patch stays applied whatever they did.
      const tail = afterPatch && typeof afterPatch === 'object' ? text((afterPatch as { tail?: unknown }).tail) : ''
      if (tail) {
        const tailLines = tail.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
        const shown = `${tailLines[0] ?? tail}${tailLines.length > 1 ? ` (+${tailLines.length - 1} more line${tailLines.length === 2 ? '' : 's'})` : ''}`
        // BL-1978: a call still running when the Stop's wait ended returned no result at all.
        lines.push(output.neverReturned === true
          ? `then: ${shown} returned no result (the reply was stopped while it ran); the patch stays applied`
          : afterPatchStarted === true
            ? `then ran: ${shown}`
            : `then not run: ${shown} (${output.stopped === true ? 'stopped before it started' : 'it could not start'}); the patch stays applied`)
      }
    }
  }
  if (output.agentBrowser && typeof output.agentBrowser === 'object') {
    lines.push(`agentBrowser: ${JSON.stringify(output.agentBrowser)}`)
  }
  if (text(output.modelImageUrl)) lines.push(`modelImageUrl: ${text(output.modelImageUrl)}`)
  if (text(output.diff)) lines.push(`diff:\n${text(output.diff)}`)

  const ran = 'stdout' in output || 'stderr' in output
  const stdout = text(output.stdout)
  const stderr = text(output.stderr)
  if (stdout) lines.push(`stdout:\n${stdout}`)
  if (stderr) lines.push(`stderr:\n${stderr}`)
  if (ran && !stdout && !stderr) lines.push('(no output)')
  return lines.join('\n')
}
