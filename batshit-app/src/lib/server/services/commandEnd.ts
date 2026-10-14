import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { endOwnedCommand, type OwnedCommand } from './ownedCommandGroup'

/**
 * How Batshit ends what a command started, on a Stop and on a timeout: ONE rule for both
 * (2026-09-18, the "Stop ends background programs" fix).
 *
 * Measured on the code before:
 * - Local shell: a program the command started in the background kept running after a Stop,
 *   even one whose parent shell had already left; and a timeout ended nothing while a program
 *   the command started still held its output (a 1 s timeout returned 12 s later, when a
 *   background `sleep 12` ended on its own; `npm run dev &` would have held the reply forever).
 * - Apple Container: `container exec` passes SIGTERM to the command's top shell only, so both
 *   parts of `sleep 61 & sleep 62` ran on inside the sandbox.
 * - sbx: `sbx exec` passes nothing into the sandbox. The whole command ran on, and the client
 *   itself exited 28.9 s after its SIGTERM.
 *
 * The rule:
 * - On the local shell a guardian leads each command group, and a Stop or timeout ends the
 *   whole group: SIGTERM, then SIGKILL `COMMAND_END_GRACE_MS` later. A tag in the environment
 *   cannot do this on a Mac, because macOS hides the environment of Apple's own programs
 *   (`sleep`, `zsh`, `bash`) from `ps`; and walking the shell's children misses a program whose
 *   parent already left, which is exactly the `npm run dev &` case.
 * - Commands used to share the app server's process group, which is how quitting Batshit ended
 *   them (the Mac supervisor stops the app server by its group). So every command group stays
 *   tracked through a live guardian while a group scan sees another live member, including a program that a FINISHED command left in the
 *   background (`nohup server > log 2>&1 &` keeps running until then), and the app server's
 *   SIGTERM ends them all the same way (a runtime shutdown task). Parent IPC EOF does the same.
 *   Only the guardian signals its own group. Retirement revokes its token before it exits; saved
 *   PIDs never authorize a signal. Programs that leave this group can escape cleanup (separate escape-class follow-up).
 * - Inside a sandbox each command carries a tag in its environment (`BATSHIT_COMMAND_ID`), and a
 *   Stop or timeout runs one short command in the same sandbox that ends every process carrying
 *   the tag, and the process groups they lead: SIGTERM, then SIGKILL for whatever is left about
 *   400 ms later. Measured: 0.1-0.6 s on Apple Container, 0.4-0.9 s on sbx. The Docker host
 *   operator keeps a plain-JS copy of this half, `tools/docker/command-end.mjs`.
 * - A command that finishes by itself is never ended: its background programs keep running.
 */

export const COMMAND_END_GRACE_MS = 400

// --- The local shell: the command's own process group ---------------------------------------

/** End through the live guardian; direct-child callers retain Node's child-handle semantics. */
export function endCommandProcess(
  child: ChildProcess | OwnedCommand,
  options: { ownGroup: boolean; graceMs?: number; afterKill?: () => void }
) {
  if (options.ownGroup) {
    endOwnedCommand(child)
    // This callback only bounds output collection. No parent timer may signal a saved PGID.
    if (options.afterKill) setTimeout(options.afterKill, COMMAND_END_GRACE_MS)
    return
  }
  child.kill('SIGTERM')
  setTimeout(() => {
    child.kill('SIGKILL')
    options.afterKill?.()
  }, options.graceMs ?? COMMAND_END_GRACE_MS)
}

// --- Inside a sandbox: a tag in the command's environment -----------------------------------

export const SANDBOX_COMMAND_TAG_ENV = 'BATSHIT_COMMAND_ID'
/** The end command's `$0`. */
export const SANDBOX_COMMAND_END_NAME = 'batshit-command-end'
/** The end command's own limit. It takes 0.1-0.9 s when the sandbox answers. */
export const SANDBOX_COMMAND_END_TIMEOUT_MS = 5_000

/**
 * Ends every process whose environment carries the tag (`$1`), and the process groups they
 * lead: SIGTERM, then SIGKILL for whatever is left after 8 × 50 ms. A process that cleared its
 * environment is still in the group of a tagged one. Group 1 is never signalled as a group:
 * `kill -- -1` means every process there is. The tag is an argument, never the end command's
 * own environment, so it never finds itself. POSIX `sh` with busybox or coreutils: measured in
 * Apple's `bash:5.2` image and in sbx's Ubuntu shell kit.
 */
export const SANDBOX_COMMAND_END_SCRIPT = String.raw`tag="BATSHIT_COMMAND_ID=$1"
cd /proc || exit 1
tagged() {
  for p in [0-9]*; do
    { tr '\0' '\n' < "$p/environ" | grep -qxF -- "$tag"; } 2>/dev/null && echo "$p"
  done
}
group_of() {
  sed 's/.*) //;s/^[^ ]* [^ ]* //;s/ .*//' "$1/stat" 2>/dev/null
}
signal_all() {
  for p in $1; do
    g=$(group_of "$p")
    if [ -n "$g" ] && [ "$g" != 1 ]; then kill -s "$2" -- "-$g" 2>/dev/null; fi
    kill -s "$2" "$p" 2>/dev/null
  done
}
pids=$(tagged)
if [ -z "$pids" ]; then echo "batshit-command-end: nothing running"; exit 0; fi
count=$(echo $pids | wc -w)
signal_all "$pids" TERM
n=0
while [ "$n" -lt 8 ]; do
  sleep 0.05
  pids=$(tagged)
  if [ -z "$pids" ]; then echo "batshit-command-end: $count ended"; exit 0; fi
  n=$((n + 1))
done
signal_all "$pids" KILL
echo "batshit-command-end: $count ended, $(echo $pids | wc -w) killed"`

export function newSandboxCommandTag(): string {
  return randomUUID()
}

/** The end command, run inside the command's sandbox: `sh -c <script> batshit-command-end <tag>`. */
export function sandboxCommandEndArgv(tag: string): string[] {
  return ['sh', '-c', SANDBOX_COMMAND_END_SCRIPT, SANDBOX_COMMAND_END_NAME, tag]
}
