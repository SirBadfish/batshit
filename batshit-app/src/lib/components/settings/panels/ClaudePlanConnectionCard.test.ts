/** SA-139 P1 (D1, D2): the Claude plan card guides install and sign-in without a CLI agent; only a user's check tells pickers. */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ClaudePlanConnectionCard from './ClaudePlanConnectionCard.svelte'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

const signedOut = { state: 'unavailable', installed: true, code: 'signed_out',
  setupCommand: 'docker compose --env-file .env.docker exec app claude auth login', setupContext: 'docker', setupWorkingDirectory: '/srv/batshit' }
const ready = { state: 'ready', installed: true, version: '2.1.296' }
const runtimes = { runtimes: { claude: { managed: { installed: true, version: '2.1.296', pinnedVersion: '2.1.296', executablePath: '/managed/claude',
  supported: true, unsupportedReason: null, displayName: 'Claude Code CLI', operation: null }, resolution: { executable: '/managed/claude', source: 'managed', found: true } } }, canManage: true }
let answers: Array<unknown | Error>, reads: number, fresh: number, events: number, order: string[], hold: Promise<void> | null
const onEvent = () => { events++; order.push('event') }
beforeEach(() => {
  reads = 0; fresh = 0; events = 0; order = []; hold = null
  window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, onEvent)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/settings/claude-plan' || path === '/api/settings/claude-plan?fresh=1') {
      reads++; if (path.endsWith('?fresh=1')) fresh++
      const answer = answers.shift()
      if (path.endsWith('?fresh=1')) { if (hold) await hold; order.push('fresh answer') }
      return answer instanceof Error ? Response.json({ error: answer.message }, { status: 500 }) : Response.json(answer)
    }
    if (path === '/api/cli-runtimes') return Response.json(runtimes)
    return Response.json({ error: `Unhandled ${path}` }, { status: 404 })
  }))
})
afterEach(() => { window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, onEvent); vi.unstubAllGlobals() })
const statusText = () => screen.getByTestId('claude-plan-status').textContent?.trim()

it('words each status plainly, shows the shared sign-in help and note, and tells pickers only after Check Again', async () => {
  answers = [signedOut, ready, new Error('Batshit could not read Claude Code status. Try again.')]
  render(ClaudePlanConnectionCard)
  await waitFor(() => expect(statusText()).toBe('Claude Code is installed but not signed in. Sign in with the command below, then press Check Again.'))
  expect(screen.getByText(signedOut.setupCommand)).toBeTruthy()
  expect(screen.getByText('Open Terminal, go to the Batshit Docker folder shown below, then run this login command once.')).toBeTruthy()
  expect(screen.getByText('/srv/batshit')).toBeTruthy()
  expect(screen.getByText(/Claude Code on Windows may hide pasted auth-code input/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy Claude Code login command' })).toBeTruthy()
  await waitFor(() => expect(screen.getByTestId('cli-runtime-manager-claude')).toBeTruthy())
  expect(screen.getByRole('link', { name: 'Check Claude Usage' }).getAttribute('href')).toBe('https://claude.ai/settings/usage')
  expect(document.body.textContent).not.toMatch(/Agent Settings|this agent/)
  expect(events).toBe(0)
  expect(fresh).toBe(0)

  // Check Again looks again (no reuse of the short-lived display read), and tells pickers only after its answer arrives.
  let release!: () => void
  hold = new Promise(resolve => { release = resolve })
  await fireEvent.click(screen.getByRole('button', { name: 'Check Again' }))
  await waitFor(() => expect(fresh).toBe(1))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(events).toBe(0)
  release(); hold = null
  await waitFor(() => expect(statusText()).toBe('Ready. Claude Code 2.1.296.'))
  expect(reads).toBe(2)
  expect(order).toEqual(['fresh answer', 'event'])
  expect(events).toBe(1)
  expect(screen.queryByText(signedOut.setupCommand)).toBeNull()

  // A failed check keeps the old status only as "Last known".
  await fireEvent.click(screen.getByRole('button', { name: 'Check Again' }))
  await waitFor(() => expect(statusText()).toBe('Last known: Ready. Claude Code 2.1.296.'))
  expect(screen.getByRole('alert').textContent).toContain('could not read Claude Code status')
  expect(events).toBe(1)
})

it.each([
  [{ state: 'unavailable', installed: false, code: 'not_installed' }, 'Claude Code is not installed yet. Install it below.', true],
  [{ state: 'unavailable', installed: true, code: 'runtime_unavailable' }, 'Claude Code is ready, but this Batshit build cannot use the Claude plan yet.', true],
  [{ state: 'unavailable', installed: true, code: 'executable_unusable' }, 'Batshit cannot use this Claude Code: it is not the exact version Batshit was tested with, or it could not run. Install or update it below, then press Check Again.', true],
  [{ state: 'unavailable', installed: false, code: 'disabled' }, 'Claude Code is turned off for this Batshit install.', false]
] as const)('says %j in one plain sentence', async (answer, sentence, installCard) => {
  answers = [answer]
  render(ClaudePlanConnectionCard)
  await waitFor(() => expect(statusText()).toBe(sentence))
  if (installCard) await waitFor(() => expect(screen.getByTestId('cli-runtime-manager-claude')).toBeTruthy())
  else expect(screen.queryByTestId('cli-runtime-manager-claude')).toBeNull()
  expect(Boolean(screen.queryByText('BATSHIT_CLAUDE_PROVIDER_ENABLED=false'))).toBe(answer.code === 'disabled')
  expect(events).toBe(0)
})

it.each([
  ['not_plan', "Claude Code is set up to use an API key, a sign-in token or a cloud provider instead of a Claude plan. Remove that from Claude Code's settings, sign in with the command below, then press Check Again."],
  ['status_unreadable', "Claude Code's sign-in does not show a Claude plan, or Batshit could not read it. Sign in with your Claude plan using the command below, then press Check Again."]
] as const)('%s shows its sentence and the sign-in command', async (code, sentence) => {
  answers = [{ ...signedOut, code }]
  render(ClaudePlanConnectionCard)
  await waitFor(() => expect(statusText()).toBe(sentence))
  expect(screen.getByText(signedOut.setupCommand)).toBeTruthy()
})
