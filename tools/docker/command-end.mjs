// The Docker host operator's copy of the sandbox half of batshit-app's `commandEnd.ts`: how a
// stopped or timed-out command's programs are ended inside its sandbox (2026-09-18). The
// operator runs from the checkout as its own Node process, so it cannot import the app's
// TypeScript; keep the two the same (`commandEnd.test.ts` compares them).
import { randomUUID } from 'node:crypto'

export const SANDBOX_COMMAND_TAG_ENV = 'BATSHIT_COMMAND_ID'
/** The end command's `$0`. */
export const SANDBOX_COMMAND_END_NAME = 'batshit-command-end'
/** The end command's own limit. It takes 0.1-0.9 s when the sandbox answers. */
export const SANDBOX_COMMAND_END_TIMEOUT_MS = 5_000

/**
 * Ends every process whose environment carries the tag (`$1`), and the process groups they
 * lead: SIGTERM, then SIGKILL for whatever is left after 8 × 50 ms. See `commandEnd.ts`.
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

export function newSandboxCommandTag() {
  return randomUUID()
}

/** The end command, run inside the command's sandbox: `sh -c <script> batshit-command-end <tag>`. */
export function sandboxCommandEndArgv(tag) {
  return ['sh', '-c', SANDBOX_COMMAND_END_SCRIPT, SANDBOX_COMMAND_END_NAME, tag]
}
