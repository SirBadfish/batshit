import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('$lib/components/ui/sonner/settings-toast', () => ({ toast: toasts }))

import ProjectsSettingsPanel from './ProjectsSettingsPanel.svelte'
import * as projectStore from '$lib/stores/projects.svelte'
import { DEFAULT_PROJECT_ID } from '$lib/projects/defaultProject'
import { resetProjectAutosaveForTests } from '$lib/components/settings/projects/projectAutosave'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import { publishProjectSaved } from '$lib/projects/projectSaveAnswers'
import { ProjectService } from '$lib/services/projects'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function record(id: string, name: string, root: string) {
  return { id, user_id: 'josh', name, root_path: root, custom_exclusions: [], created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00Z' }
}

function routes(options: { projects?: ReturnType<typeof record>[]; defaultPath?: string | null; preferencesFail?: number } = {}) {
  const projects = options.projects ?? [record('project_a', 'Alpha', '/fixture/alpha'), record('project_b', 'Beta', '/fixture/beta')]
  let defaultPath = options.defaultPath === undefined ? '/fixture/workspace' : options.defaultPath
  let preferenceReadFailures = options.preferencesFail ?? 0
  const writes: Array<{ url: string; method: string; body: Record<string, any> }> = []
  const failingPuts = new Set<string>()
  const failingPreferenceSaves = new Set<string>()
  let heldPut: Promise<void> | undefined
  let heldPost: Promise<void> | undefined
  let heldDelete: Promise<void> | undefined
  let heldList: Promise<void> | undefined
  let failDeletes = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET'
    if (url === '/api/projects/preferences' && method === 'GET') {
      if (preferenceReadFailures > 0) {
        preferenceReadFailures -= 1
        return json({ error: 'Failed to load preferences' }, 500)
      }
      return json({ preferences: defaultPath ? { default_workspace_path: defaultPath } : null })
    }
    if (url === '/api/projects/preferences' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      writes.push({ url, method, body })
      const hold = heldPost
      heldPost = undefined
      if (hold) await hold
      if (failingPreferenceSaves.has(body.defaultWorkspacePath)) return json({ error: 'Fixture preference write unavailable' }, 503)
      defaultPath = body.defaultWorkspacePath
      return json({ preferences: defaultPath ? { default_workspace_path: defaultPath } : null })
    }
    if (url === '/api/projects' && method === 'GET') {
      // The server reads the list when the request arrives; a held answer stays that old copy.
      const snapshot = structuredClone(projects)
      const hold = heldList
      heldList = undefined
      if (hold) await hold
      return json({ projects: snapshot })
    }
    if (url === '/api/projects' && method === 'DELETE') {
      const body = JSON.parse(String(init.body))
      writes.push({ url, method, body })
      const hold = heldDelete
      heldDelete = undefined
      if (hold) await hold
      if (failDeletes) return json({ error: 'Fixture delete unavailable' }, 503)
      const index = projects.findIndex((entry) => entry.id === body.projectId)
      if (index >= 0) projects.splice(index, 1)
      return json({ success: true })
    }
    if (url === '/api/projects' && method === 'PUT') {
      const body = JSON.parse(String(init.body))
      writes.push({ url, method, body })
      const hold = heldPut
      heldPut = undefined
      if (hold) await hold
      if (failingPuts.has(body.projectId)) return json({ error: 'Fixture write unavailable' }, 503)
      const target = projects.find((entry) => entry.id === body.projectId)
      if (!target) return json({ error: 'Project not found' }, 404)
      Object.assign(target, body.updates)
      return json({ project: { ...target } })
    }
    throw new Error(`Unexpected fixture request ${method} ${url}`)
  }))
  return {
    writes,
    puts: () => writes.filter((write) => write.method === 'PUT'),
    failPut: (projectId: string) => failingPuts.add(projectId),
    failPreferenceSave: (path: string) => failingPreferenceSaves.add(path),
    failDeletes: () => { failDeletes = true },
    /** Holds the next list read's answer (read at request time) until released. */
    holdList: () => {
      let release!: () => void
      heldList = new Promise<void>((resolve) => { release = resolve })
      return () => release()
    },
    /** Holds the next DELETE's answer until the returned release is called. */
    holdDelete: () => {
      let release!: () => void
      heldDelete = new Promise<void>((resolve) => { release = resolve })
      return () => release()
    },
    /** Holds the next preference save's answer until the returned release is called. */
    holdPost: () => {
      let release!: () => void
      heldPost = new Promise<void>((resolve) => { release = resolve })
      return () => release()
    },
    /** Holds the next PUT's answer until the returned release is called. */
    holdPut: () => {
      let release!: () => void
      heldPut = new Promise<void>((resolve) => { release = resolve })
      return () => release()
    }
  }
}

async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await tick() } }

function savedProjectRow(name: string) {
  return Array.from(document.querySelectorAll('button.settings-sidebar-item')).find(
    (button) => button.querySelector('.settings-sidebar-item-title')?.textContent?.trim() === name
  ) as HTMLElement
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const fn of Object.values(toasts)) fn.mockReset()
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', {
    configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  projectStore.setProjects([])
  projectStore.setDefaultProjectPath(null)
  resetProjectAutosaveForTests()
})

describe('BL-2373: the Default Project in Settings > Projects', () => {
  it('lists the Default Project first in Saved Projects with its saved path', async () => {
    routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('/fixture/workspace')

    const rows = Array.from(row.parentElement!.querySelectorAll('button.settings-sidebar-item')).map((button) => [
      button.querySelector('.settings-sidebar-item-title')?.textContent?.trim(),
      button.querySelector('.settings-sidebar-item-subtext')?.textContent?.trim()
    ])
    expect(rows).toEqual([
      ['Default Project', '/fixture/workspace'],
      ['Alpha', '/fixture/alpha'],
      ['Beta', '/fixture/beta']
    ])
    // The read publishes the path to the store the sidebar and chat read.
    expect(projectStore.getDefaultProject()?.id).toBe(DEFAULT_PROJECT_ID)
    expect(projectStore.getDefaultProjectPath()).toBe('/fixture/workspace')
  })

  // Hydration never saves, and (review A4) a pause in typing never saves a half-typed path:
  // only leaving the field or pressing Enter commits it.
  it('opening it saves nothing; a typing pause saves nothing; leaving the field saves once and updates the store', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const r = routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('/fixture/workspace')
    await fireEvent.click(row)
    const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement
    expect(input.value).toBe('/fixture/workspace')
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.writes).toHaveLength(0)

    await fireEvent.input(input, { target: { value: '/' } })
    await vi.advanceTimersByTimeAsync(650)
    await fireEvent.input(input, { target: { value: '/fixture/other' } })
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.writes).toHaveLength(0)
    expect(projectStore.getDefaultProject()?.root_path).toBe('/fixture/workspace')

    await fireEvent.blur(input)
    await flush()
    expect(r.writes).toEqual([{ url: '/api/projects/preferences', method: 'POST', body: { defaultWorkspacePath: '/fixture/other' } }])
    expect(projectStore.getDefaultProject()?.root_path).toBe('/fixture/other')

    // Enter commits too; an unchanged value is not sent again.
    await fireEvent.input(input, { target: { value: '/fixture/third' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    await fireEvent.blur(input)
    await flush()
    expect(r.writes.map((write) => write.body.defaultWorkspacePath)).toEqual(['/fixture/other', '/fixture/third'])
  })

  it('a relative path is refused on commit and never saved', async () => {
    const r = routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('/fixture/workspace')
    await fireEvent.click(row)
    const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'relative/folder' } })
    await fireEvent.blur(input)
    await flush()
    expect(r.writes).toHaveLength(0)
    expect(await screen.findByText('Default workspace path must be absolute.')).toBeInTheDocument()
  })

  // Review nit: a value the panel could not read is never written over.
  it('after a failed read the path field is disabled and nothing is saved', async () => {
    const r = routes({ preferencesFail: 1 })
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('Unavailable')
    await fireEvent.click(row)
    const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement
    expect(input.disabled).toBe(true)
    await fireEvent.blur(input)
    await flush()
    expect(r.writes).toHaveLength(0)
  })

  it('with no saved projects the Default Project is selected', async () => {
    routes({ projects: [] })
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement
    await flush()
    expect(input.value).toBe('/fixture/workspace')
    expect(screen.getByTestId('default-project-row').getAttribute('data-state')).toBe('active')
  })
})

describe('BL-2384: a project edit saves to the project it was typed into', () => {
  async function mountWithAlpha() {
    const r = routes()
    const view = render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    return { r, name, view }
  }

  it('picking another project before the autosave fires does not write the edit onto it', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await fireEvent.click(savedProjectRow('Beta'))
    await vi.advanceTimersByTimeAsync(650)
    await flush()

    const puts = r.writes.filter((write) => write.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toMatchObject({ projectId: 'project_a', updates: { name: 'Alpha Renamed', root_path: '/fixture/alpha' } })
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Beta')
  })

  // Review B1: one shared debounce kept only the latest call and dropped A's save silently.
  it('editing A, selecting B and editing B within 600 ms saves both', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await fireEvent.click(savedProjectRow('Beta'))
    await fireEvent.input(screen.getByLabelText('Project Name'), { target: { value: 'Beta Renamed' } })
    await vi.advanceTimersByTimeAsync(650)
    await flush()

    const puts = r.writes.filter((write) => write.method === 'PUT').map((write) => [write.body.projectId, write.body.updates.name])
    expect(puts.sort()).toEqual([
      ['project_a', 'Alpha Renamed'],
      ['project_b', 'Beta Renamed']
    ])
  })

  // Review B2: a failed save of a project no longer shown names that project and leaves the shown one alone.
  it('a failed save of a project no longer shown is a toast naming it', async () => {
    const { r, name } = await mountWithAlpha()
    r.failPut('project_a')
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await fireEvent.click(savedProjectRow('Beta'))
    await vi.advanceTimersByTimeAsync(650)
    await flush()

    expect(toasts.error).toHaveBeenCalledWith('Alpha Renamed was not saved: Fixture write unavailable')
    expect(screen.queryByText('Fixture write unavailable')).toBeNull()
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Beta')
  })
})

/**
 * BL-2384 round 3 (the reviewers' save follow-ups): edits typed during a save's round trip, a
 * reselected project with a save still waiting or on its way, saves that fail after the panel
 * closed, and a delete with a save still waiting.
 */
describe('BL-2384: saves keep every edit, in order, also after the panel closes', () => {
  async function mountWithAlpha() {
    const r = routes()
    const view = render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    return { r, name, view }
  }

  it('text typed while a save is on its way is kept and sent next (S1a)', async () => {
    const { r, name } = await mountWithAlpha()
    const release = r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha 1' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha 1'])

    await fireEvent.input(name, { target: { value: 'Alpha 12' } })
    release()
    await flush()
    expect(name.value).toBe('Alpha 12')

    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha 1', 'Alpha 12'])
    expect(name.value).toBe('Alpha 12')
  })

  it('a project reselected while its save is on its way shows that save, and a later edit keeps it (S1b)', async () => {
    const { r, name } = await mountWithAlpha()
    const release = r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await vi.advanceTimersByTimeAsync(650)

    await fireEvent.click(savedProjectRow('Beta'))
    await fireEvent.click(savedProjectRow('Alpha'))
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Alpha Renamed')

    await fireEvent.input(screen.getByLabelText('Root Path'), { target: { value: '/fixture/alpha-two' } })
    release()
    await flush()
    await vi.advanceTimersByTimeAsync(650)
    await flush()

    const puts = r.puts().map((put) => [put.body.updates.name, put.body.updates.root_path])
    expect(puts).toEqual([
      ['Alpha Renamed', '/fixture/alpha'],
      ['Alpha Renamed', '/fixture/alpha-two']
    ])
  })

  it('a project reselected while its save is still waiting shows the waiting edit (S1b)', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'Alpha Waiting' } })
    await fireEvent.click(savedProjectRow('Beta'))
    await fireEvent.click(savedProjectRow('Alpha'))
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Alpha Waiting')
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha Waiting'])
  })

  it('an edit still waiting when the panel closes is sent, and its failure is a named toast (S2)', async () => {
    const { r, name, view } = await mountWithAlpha()
    r.failPut('project_a')
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    view.unmount()
    await flush()
    expect(r.puts()).toHaveLength(1)
    await vi.waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('Alpha Renamed was not saved: Fixture write unavailable')
    )
  })

  it('deleting a project with a save still waiting sends no PUT and no notice (S3)', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await fireEvent.click(screen.getByRole('button', { name: /Delete Project/ }))
    const confirm = screen.getAllByRole('button', { name: /Delete Project/ }).at(-1)!
    await fireEvent.click(confirm)
    await flush()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.writes.filter((write) => write.method === 'DELETE')).toHaveLength(1)
    expect(r.puts()).toHaveLength(0)
    expect(toasts.error).not.toHaveBeenCalled()
  })
})

describe('BL-2373 round 3: the Default Project path when the panel closes', () => {
  async function openDefaultProject(r = routes()) {
    const view = render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('/fixture/workspace')
    await fireEvent.click(row)
    const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement
    return { r, view, input }
  }

  it('a typed path the field never left is saved exactly once when the panel closes (S4)', async () => {
    const { r, view, input } = await openDefaultProject()
    await fireEvent.input(input, { target: { value: '/fixture/typed-then-closed' } })
    view.unmount()
    await flush()
    expect(r.writes).toEqual([
      { url: '/api/projects/preferences', method: 'POST', body: { defaultWorkspacePath: '/fixture/typed-then-closed' } }
    ])
    expect(projectStore.getDefaultProjectPath()).toBe('/fixture/typed-then-closed')
  })

  it('that save failing after the panel closed is a named toast (S2)', async () => {
    const r = routes()
    r.failPreferenceSave('/fixture/will-fail')
    const { view, input } = await openDefaultProject(r)
    await fireEvent.input(input, { target: { value: '/fixture/will-fail' } })
    view.unmount()
    await vi.waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('The Default Project path was not saved: Fixture preference write unavailable')
    )
    expect(projectStore.getDefaultProjectPath()).toBe('/fixture/workspace')
  })

  it('when a later commit fails, the store keeps the earlier commit the server saved', async () => {
    const r = routes()
    r.failPreferenceSave('/fixture/second')
    const { input } = await openDefaultProject(r)
    // The first commit is still on its way when the second is made.
    const release = r.holdPost()
    await fireEvent.input(input, { target: { value: '/fixture/first' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    await fireEvent.input(input, { target: { value: '/fixture/second' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    release()
    await flush()
    await vi.waitFor(() => expect(screen.getByText('Fixture preference write unavailable')).toBeInTheDocument())
    expect(r.writes.map((write) => write.body.defaultWorkspacePath)).toEqual(['/fixture/first', '/fixture/second'])
    expect(projectStore.getDefaultProjectPath()).toBe('/fixture/first')
  })

  it('Refresh retries a preference read that failed', async () => {
    routes({ preferencesFail: 1 })
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const row = await screen.findByTestId('default-project-row')
    await within(row).findByText('Unavailable')
    await fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    // The list reloads, so the row is drawn again.
    await vi.waitFor(() =>
      expect(within(screen.getByTestId('default-project-row')).getByText('/fixture/workspace')).toBeInTheDocument()
    )
    await fireEvent.click(screen.getByTestId('default-project-row'))
    expect(((await screen.findByLabelText('Root Path')) as HTMLInputElement).disabled).toBe(false)
  })
})

/** BL-2384 round 4: the reviewers' follow-ups on round 3's save owner. */
describe('BL-2384 round 4: bounded reads, deletes and cancelled copies', () => {
  async function mountWithAlpha() {
    const r = routes()
    const view = render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    return { r, name, view }
  }

  async function deleteShownProject() {
    await fireEvent.click(screen.getByRole('button', { name: /Delete Project/ }))
    await fireEvent.click(screen.getAllByRole('button', { name: /Delete Project/ }).at(-1)!)
  }

  it('a write that never answers does not hold a reopened panel on loading; its copy still shows (1)', async () => {
    const { r, name, view } = await mountWithAlpha()
    r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    view.unmount()
    await flush()
    expect(r.puts()).toHaveLength(1)

    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    await flush()
    expect(screen.getByText('Loading projects…')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(3100)
    await flush()
    expect(screen.queryByText('Loading projects…')).toBeNull()
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Alpha Renamed')
  })

  it('an edit returned to the saved value cancels its waiting copy (c)', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'Alpha X' } })
    await fireEvent.input(name, { target: { value: 'Alpha' } })
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts()).toHaveLength(0)
  })

  it('a failed delete puts the cancelled edit back (b)', async () => {
    const { r, name } = await mountWithAlpha()
    r.failDeletes()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await deleteShownProject()
    await flush()
    expect(await screen.findByText('Fixture delete unavailable')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha Renamed'])
  })

  it('a failed delete does not put back a cancelled copy older than an edit made meanwhile (3)', async () => {
    const { r, name } = await mountWithAlpha()
    r.failDeletes()
    const releaseDelete = r.holdDelete()
    await fireEvent.input(name, { target: { value: 'Alpha Old' } })
    await deleteShownProject()
    await fireEvent.input(screen.getByLabelText('Project Name'), { target: { value: 'Alpha New' } })
    releaseDelete()
    await flush()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha New'])
  })

  it('a save that failed while its project was being deleted is shown when the delete fails (4)', async () => {
    const { r, name } = await mountWithAlpha()
    const releasePut = r.holdPut()
    r.failPut('project_a')
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.puts()).toHaveLength(1)

    r.failDeletes()
    const releaseDelete = r.holdDelete()
    await deleteShownProject()
    releasePut()
    await flush()
    expect(toasts.error).not.toHaveBeenCalled()

    releaseDelete()
    await vi.waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('Alpha Renamed was not saved: Fixture write unavailable')
    )
  })

  it('when the newer of two Root Path commits succeeds, the update fires once and the replaced value is never published (a)', async () => {
    const r = routes()
    const events: Array<string | null> = []
    const listen = (event: Event) => events.push((event as CustomEvent).detail?.defaultWorkspacePath ?? null)
    window.addEventListener(LIVE_SETTINGS_EVENTS.projectPreferencesUpdated, listen)
    try {
      render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
      const row = await screen.findByTestId('default-project-row')
      await within(row).findByText('/fixture/workspace')
      await fireEvent.click(row)
      const input = (await screen.findByLabelText('Root Path')) as HTMLInputElement

      const releaseFirst = r.holdPost()
      await fireEvent.input(input, { target: { value: '/fixture/first' } })
      await fireEvent.keyDown(input, { key: 'Enter' })
      await fireEvent.input(input, { target: { value: '/fixture/second' } })
      await fireEvent.keyDown(input, { key: 'Enter' })
      const releaseSecond = r.holdPost()
      releaseFirst()
      await flush()
      expect(projectStore.getDefaultProjectPath()).toBe('/fixture/workspace')
      expect(events).toEqual([])

      releaseSecond()
      await vi.waitFor(() => expect(projectStore.getDefaultProjectPath()).toBe('/fixture/second'))
      expect(events).toEqual(['/fixture/second'])
      expect(r.writes.map((write) => write.body.defaultWorkspacePath)).toEqual(['/fixture/first', '/fixture/second'])
    } finally {
      window.removeEventListener(LIVE_SETTINGS_EVENTS.projectPreferencesUpdated, listen)
    }
  })
})

/**
 * BL-2384 round 5: a write slower than the reopened panel's bounded wait. Its answer must reach
 * the panel that is open now, not only the closed one that sent it.
 */
describe('BL-2384 round 5: an answer that arrives after the bounded wait', () => {
  async function closeWithWriteOnItsWay() {
    const r = routes()
    const first = render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    const releasePut = r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha Renamed' } })
    first.unmount()
    await flush()
    expect(r.puts()).toHaveLength(1)
    return { r, releasePut }
  }

  it('the reopened panel takes the answer: no stale Saving, a saved baseline, and an edit back to the old value is saved', async () => {
    const { r, releasePut } = await closeWithWriteOnItsWay()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    await vi.advanceTimersByTimeAsync(3100)
    await flush()
    const name = screen.getByLabelText('Project Name') as HTMLInputElement
    expect(name.value).toBe('Alpha Renamed')
    // (d) This panel did not send that copy.
    expect(screen.queryByText('Saving...')).toBeNull()

    releasePut()
    await flush()
    expect(screen.queryByText('Saving...')).toBeNull()

    // (b) Editing the changed field back to the old value is a real edit now, and is saved.
    await fireEvent.input(name, { target: { value: 'Alpha' } })
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha Renamed', 'Alpha'])
  })

  it('a list the server read before the write landed does not put old values back in the store (c)', async () => {
    const { r, releasePut } = await closeWithWriteOnItsWay()
    const releaseList = r.holdList()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    await vi.advanceTimersByTimeAsync(3100)
    await flush()

    releasePut()
    await flush()
    expect(projectStore.getProjects().find((project) => project.id === 'project_a')?.name).toBe('Alpha Renamed')

    releaseList()
    await flush()
    expect(projectStore.getProjects().find((project) => project.id === 'project_a')?.name).toBe('Alpha Renamed')
    expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Alpha Renamed')
  })

  it('a project deleted while an edit of it was queued sends no PUT after the delete', async () => {
    const r = routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    const releaseDelete = r.holdDelete()
    await fireEvent.click(screen.getByRole('button', { name: /Delete Project/ }))
    await fireEvent.click(screen.getAllByRole('button', { name: /Delete Project/ }).at(-1)!)
    await fireEvent.input(name, { target: { value: 'Alpha During Delete' } })
    releaseDelete()
    await flush()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.writes.filter((write) => write.method === 'DELETE')).toHaveLength(1)
    expect(r.puts()).toHaveLength(0)
    expect(toasts.error).not.toHaveBeenCalled()
  })
})

describe('BL-2384 round 6: the Saved status', () => {
  it('an older answer shows Saved only once no newer copy of that project is waiting or on its way', async () => {
    const r = routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    const releaseFirst = r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha 1' } })
    await vi.advanceTimersByTimeAsync(650)
    await fireEvent.input(name, { target: { value: 'Alpha 12' } })
    await vi.advanceTimersByTimeAsync(650)
    const releaseSecond = r.holdPut()

    releaseFirst()
    await flush()
    expect(screen.queryByText('Project Saved')).toBeNull()
    expect(screen.getByText('Saving...')).toBeInTheDocument()

    releaseSecond()
    await vi.waitFor(() => expect(screen.getByText('Project Saved')).toBeInTheDocument())
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha 1', 'Alpha 12'])
  })
})

describe('BL-2384 round 6: an answer between the list read and its assignment', () => {
  it('is laid over the list where the panel assigns it, so the newer copy stays', async () => {
    routes()
    const newer = { ...record('project_a', 'Alpha Saved', '/fixture/alpha'), updated_at: '2026-10-27T12:00:05Z' }
    vi.spyOn(ProjectService.prototype, 'loadProjects').mockImplementationOnce(async () => {
      const list = [record('project_a', 'Alpha', '/fixture/alpha'), record('project_b', 'Beta', '/fixture/beta')]
      // Runs after the service returned and before the panel's await resumes.
      void Promise.resolve().then(() =>
        publishProjectSaved('project_a', newer, { id: 'project_a', name: 'Alpha Saved' } as any)
      )
      return list
    })
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    await screen.findByDisplayValue('Alpha Saved')
    expect(savedProjectRow('Alpha Saved')).toBeTruthy()
  })
})

describe('BL-2384 round 6: an edit back to the saved value leaves Saving', () => {
  async function mountWithAlpha() {
    const r = routes()
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'josh' } } } })
    const name = (await screen.findByDisplayValue('Alpha')) as HTMLInputElement
    await tick()
    vi.useFakeTimers()
    return { r, name }
  }

  it('a character typed and removed within 600 ms leaves no Saving status and sends nothing', async () => {
    const { r, name } = await mountWithAlpha()
    await fireEvent.input(name, { target: { value: 'AlphaX' } })
    expect(screen.getByText('Saving...')).toBeInTheDocument()
    await fireEvent.input(name, { target: { value: 'Alpha' } })
    await flush()
    expect(screen.queryByText('Saving...')).toBeNull()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts()).toHaveLength(0)
    expect(screen.queryByText('Saving...')).toBeNull()
  })

  it('an answer held back from Saved, then the waiting newer copy edited back away, leaves no Saving status', async () => {
    const { r, name } = await mountWithAlpha()
    const releaseFirst = r.holdPut()
    await fireEvent.input(name, { target: { value: 'Alpha 1' } })
    await vi.advanceTimersByTimeAsync(650)
    await fireEvent.input(name, { target: { value: 'Alpha 12' } })
    releaseFirst()
    await flush()
    // The first copy answered while the newer one waits: Saved is held back.
    expect(screen.getByText('Saving...')).toBeInTheDocument()

    await fireEvent.input(name, { target: { value: 'Alpha 1' } })
    await flush()
    expect(screen.queryByText('Saving...')).toBeNull()
    await vi.advanceTimersByTimeAsync(650)
    await flush()
    expect(r.puts().map((put) => put.body.updates.name)).toEqual(['Alpha 1'])
  })
})
