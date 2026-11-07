import { fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectsSettingsPanel from './ProjectsSettingsPanel.svelte'
import * as projectStore from '$lib/stores/projects.svelte'
import { resetProjectAutosaveForTests } from '$lib/components/settings/projects/projectAutosave'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function routes(empty = false, other = false) {
  let project = { id: 'depth_project', user_id: 'depth_user', name: 'Depth Project', root_path: '/fixture/project',
    max_depth: 10, custom_exclusions: [], created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z' }
  const writes: Array<{ method: string; body: Record<string, any> }> = []
  let hold: Promise<void> | undefined
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET'
    if (url === '/api/projects/preferences') return json({ preferences: null })
    if (url === '/api/projects' && method === 'GET') return json({ projects: empty ? [] : [project,
      ...(other ? [{ ...project, id: 'other_project', name: 'Other Depth Project', max_depth: 7 }] : [])] })
    if (url === '/api/projects' && (method === 'PUT' || method === 'POST')) {
      const body = JSON.parse(String(init.body))
      writes.push({ method, body })
      if (fail) { fail = false; return json({ error: 'Fixture write unavailable' }, 503) }
      project = { ...project, ...(method === 'PUT' ? body.updates : body) }
      const saved = structuredClone(project), pending = hold
      hold = undefined
      if (pending) await pending
      return json({ project: saved })
    }
    if (method === 'GET') return json({})
    throw new Error(`Unexpected fixture request ${method} ${url}`)
  }))
  return { writes, stored: () => project, failNext: () => { fail = true }, holdNext: () => {
    let release!: () => void
    hold = new Promise<void>(resolve => { release = resolve })
    return release
  } }
}

async function mountedEdit(other = false) {
  const r = routes(false, other)
  render(ProjectsSettingsPanel, { props: { data: { user: { id: 'depth_user' } } } })
  await screen.findByDisplayValue('Depth Project')
  await tick()
  vi.useFakeTimers()
  return { r, depth: screen.getByLabelText('Max Depth') as HTMLInputElement }
}

async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await tick() } }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
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
  resetProjectAutosaveForTests()
})

describe('Projects Max Depth string draft', () => {
  it('enters digits in the mounted edit field and completes its existing autosave', async () => {
    const { r, depth } = await mountedEdit()
    await vi.advanceTimersByTimeAsync(650)
    expect(r.writes).toHaveLength(0)
    await fireEvent.input(depth, { target: { value: '12' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toMatchObject({ method: 'PUT', body: { projectId: 'depth_project', updates: { max_depth: 12 } } })
    expect(depth.value).toBe('12')
  })

  it('retains incomplete syntax and refuses to save it without adding a blur policy', async () => {
    const { r, depth } = await mountedEdit()
    depth.focus()
    await tick()
    expect(document.activeElement === depth).toBe(true)
    for (const raw of ['-', '.', '2.', '1e', '-1']) {
      await fireEvent.input(depth, { target: { value: raw } })
      await vi.advanceTimersByTimeAsync(650)
      expect(depth.value).toBe(raw)
      expect(r.writes).toHaveLength(0)
      expect(screen.getByText('Max depth must be a non-negative number.')).toBeTruthy()
    }
    await fireEvent.input(depth, { target: { value: '200000' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.writes[0]?.body.updates.max_depth).toBe(200000)
    expect(document.activeElement === depth).toBe(true)
  })

  it('keeps the existing blank omission contract and never substitutes zero', async () => {
    const { r, depth } = await mountedEdit()
    await fireEvent.input(depth, { target: { value: '' } })
    expect(depth.value).toBe('')
    await vi.advanceTimersByTimeAsync(650)
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]?.body.updates).not.toHaveProperty('max_depth')
    expect(r.stored().max_depth).toBe(10)
  })

  it.each([['0', 0], ['2.5', 2.5], ['2e2', 200]] as const)('saves complete %s according to the existing number contract', async (raw, saved) => {
    const { r, depth } = await mountedEdit()
    await fireEvent.input(depth, { target: { value: raw } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]?.body.updates.max_depth).toBe(saved)
    expect(r.stored().max_depth).toBe(saved)
  })

  it.each(['1e', '20'])('keeps a newer %s draft when an older save answers', async raw => {
    const { r, depth } = await mountedEdit()
    const release = r.holdNext()
    try {
      await fireEvent.input(depth, { target: { value: '12' } })
      await vi.advanceTimersByTimeAsync(650)
      expect(r.writes).toHaveLength(1)
      await fireEvent.input(depth, { target: { value: raw } })
      release()
      await flush()
      expect(depth.value).toBe(raw)
      if (raw === '20') {
        await vi.advanceTimersByTimeAsync(650)
        expect(r.writes).toHaveLength(2)
        expect(r.stored().max_depth).toBe(20)
      } else {
        await vi.advanceTimersByTimeAsync(650)
        expect(r.writes).toHaveLength(1)
      }
    } finally { release(); await flush() }
  })

  it('keeps the newly selected project depth when an older project save answers', async () => {
    const { r, depth } = await mountedEdit(true)
    const release = r.holdNext()
    try {
      await fireEvent.input(depth, { target: { value: '12' } })
      await vi.advanceTimersByTimeAsync(650)
      expect(r.writes).toHaveLength(1)
      await fireEvent.click(screen.getByRole('button', { name: /Other Depth Project/ }))
      release()
      await flush()
      expect((screen.getByLabelText('Project Name') as HTMLInputElement).value).toBe('Other Depth Project')
      expect((screen.getByLabelText('Max Depth') as HTMLInputElement).value).toBe('7')
      await vi.advanceTimersByTimeAsync(650)
      expect(r.writes).toHaveLength(1)
      expect(projectStore.getProjects().find(project => project.id === 'depth_project')?.max_depth).toBe(12)
    } finally { release(); await flush() }
  })

  it('retains a failed newer depth save without hiding its error or retrying after an older answer', async () => {
    const { r, depth } = await mountedEdit()
    const release = r.holdNext()
    try {
      await fireEvent.input(depth, { target: { value: '12' } })
      await vi.advanceTimersByTimeAsync(650)
      r.failNext()
      await fireEvent.input(depth, { target: { value: '20' } })
      await vi.advanceTimersByTimeAsync(650)
      // BL-2384: writes of one project are ordered, so the newer save waits for the older answer.
      expect(r.writes).toHaveLength(1)
      release()
      await flush()
      expect(r.writes).toHaveLength(2)
      await vi.waitFor(() => expect(document.body.textContent?.includes('Fixture write unavailable')).toBe(true))
      expect(depth.value).toBe('20')
      expect(document.body.textContent?.includes('Fixture write unavailable')).toBe(true)
      await vi.advanceTimersByTimeAsync(2650)
      expect(r.writes).toHaveLength(2)
    } finally { release(); await flush() }
  })

  it('enters digits in the mounted create field and saves on Create Project', async () => {
    const r = routes(true)
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'depth_user' } }, initialMode: 'create' } })
    await screen.findByLabelText('Project Name')
    await fireEvent.input(screen.getByLabelText('Project Name'), { target: { value: 'New Depth Project' } })
    await fireEvent.input(screen.getByLabelText('Root Path'), { target: { value: '/fixture/new-project' } })
    await fireEvent.input(screen.getByLabelText('Max Depth'), { target: { value: '12' } })
    expect(r.writes).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Create Project', exact: true }))
    await tick()
    expect(r.writes).toHaveLength(1)
    expect(r.writes[0]).toMatchObject({ method: 'POST', body: { max_depth: 12 } })
  })

  it.each(['', '0', '1e'])('keeps create %j explicit and preserves blank/zero/partial meaning', async raw => {
    const r = routes(true)
    render(ProjectsSettingsPanel, { props: { data: { user: { id: 'depth_user' } }, initialMode: 'create' } })
    await screen.findByLabelText('Project Name')
    await fireEvent.input(screen.getByLabelText('Project Name'), { target: { value: 'New Depth Project' } })
    await fireEvent.input(screen.getByLabelText('Root Path'), { target: { value: '/fixture/new-project' } })
    const depth = screen.getByLabelText('Max Depth') as HTMLInputElement
    await fireEvent.input(depth, { target: { value: raw } })
    expect(depth.value).toBe(raw)
    expect(r.writes).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Create Project', exact: true }))
    await flush()
    if (raw === '1e') {
      expect(r.writes).toHaveLength(0)
      expect(depth.value).toBe('1e')
    } else {
      expect(r.writes).toHaveLength(1)
      if (raw === '') expect(r.writes[0]?.body).not.toHaveProperty('max_depth')
      else expect(r.writes[0]?.body.max_depth).toBe(0)
    }
  })
})
