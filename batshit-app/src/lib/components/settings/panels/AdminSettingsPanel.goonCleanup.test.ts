import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { installUserSettingsRoutes, loadUserSettingsRoute, jsonResponse } from '$lib/test-utils/userSettingsRoute'
import { confirmDialog } from '$lib/stores/confirmDialog'
import { GET, POST } from '../../../../routes/api/admin/goon-assets/+server'
import AdminSettingsPanel from './AdminSettingsPanel.svelte'

vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => false) }))
useRedisTestServer()
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
beforeEach(() => {
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(false)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function openPanel(failDelete = false, failAuditRefresh = false) {
  await redis.json.set('upload:goons:old.vrm', '$', { size: 100, base64: 'AQID' })
  await redis.json.set('upload:goon_scenes:lost.jpg', '$', { size: 1234, base64: 'BAUG' })
  vi.stubEnv('BATSHIT_TOKEN', 'bl1025-test-service-token')
  const locals = { user: { id: 'bl1025', is_admin: true } }
  const cleanupPosts: any[] = []
  let audits = 0
  installUserSettingsRoutes({ userId: 'bl1025', route: await loadUserSettingsRoute(),
    extra: async (path, method, init) => {
      if (path === '/api/admin/goon-assets') {
        if (method === 'GET') {
          audits++
          if (failAuditRefresh && audits > 1) return jsonResponse({ error: 'Audit refresh unavailable' }, 503)
          return await GET({ locals } as any) as Response
        }
        cleanupPosts.push(JSON.parse(String(init.body)))
        return await POST({ locals, request: new Request('http://localhost/api/admin/goon-assets', { method: 'POST', body: String(init.body) }) } as any) as Response
      }
      if (path.endsWith('/api/upload/asset') && method === 'DELETE') {
        if (failDelete) return jsonResponse({ error: 'File service unavailable' }, 503)
        const body = JSON.parse(String(init.body))
        await redis.del(`upload:${body.uploadType}:${body.filename}`)
        return jsonResponse({ success: true })
      }
      return undefined
    }
  })
  render(AdminSettingsPanel, { data: { user: locals.user, userSettings: null } as any })
  const card = screen.getByText('Goon Asset Cleanup').closest('details') as HTMLDetailsElement
  const inspect = within(card).getByRole('button', { name: 'Inspect' })
  await fireEvent.click(inspect)
  await waitFor(() => expect(screen.getByText('1 eligible for cleanup')).toBeTruthy())
  return { cleanupPosts, audits: () => audits }
}

describe('Rendered Admin cleanup confirmation with actual routes (BL-1025)', () => {
  it('Inspect and a cancelled cleanup write nothing', async () => {
    const fixture = await openPanel()
    expect(fixture.cleanupPosts).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Clean Orphans' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    expect(fixture.cleanupPosts).toEqual([])
    expect(await redis.exists('upload:goons:old.vrm')).toBe(true)
    expect(await redis.exists('upload:goon_scenes:lost.jpg')).toBe(true)
    expect(vi.mocked(confirmDialog).mock.calls[0][0].description).toContain('1 Scene file with unknown reference history will stay in storage.')
  }, 60_000)

  it('confirmation deletes only inspected eligible files, preserves Scene data, and refreshes the audit', async () => {
    const fixture = await openPanel()
    let release!: (confirmed: boolean) => void
    vi.mocked(confirmDialog).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await fireEvent.click(screen.getByRole('button', { name: 'Clean Orphans' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    await redis.json.set('upload:goons:later.vrm', '$', { size: 50, base64: 'AA==' })
    expect(fixture.cleanupPosts).toEqual([])
    release(true)
    await waitFor(() => expect(fixture.audits()).toBe(2))
    expect(fixture.cleanupPosts).toEqual([{ confirmDeleteOrphans: true, selectedAssets: ['goons/old.vrm'] }])
    expect(await redis.exists('upload:goons:old.vrm')).toBe(false)
    expect(await redis.exists('upload:goons:later.vrm')).toBe(true)
    expect(await redis.json.get('upload:goon_scenes:lost.jpg')).toMatchObject({ size: 1234, base64: 'BAUG' })
    await waitFor(() => expect(screen.queryByText('old.vrm')).toBeNull())
    expect(screen.getByText('later.vrm')).toBeTruthy()
  }, 60_000)

  it('keeps a cleanup failure visible after the refreshed audit finishes', async () => {
    const fixture = await openPanel(true)
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Clean Orphans' }))
    await waitFor(() => expect(fixture.audits()).toBe(2))
    await waitFor(() => expect(screen.getByText('Some orphaned Goon assets could not be deleted')).toBeTruthy())
    expect(await redis.exists('upload:goons:old.vrm')).toBe(true)
    expect(screen.getByText('old.vrm')).toBeTruthy()
    expect(await redis.exists('upload:goon_scenes:lost.jpg')).toBe(true)
  }, 60_000)

  it('reports both cleanup and refresh failure without discarding either cause', async () => {
    const fixture = await openPanel(true, true)
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Clean Orphans' }))
    await waitFor(() => expect(fixture.audits()).toBe(2))
    await waitFor(() => expect(screen.getByText('Some orphaned Goon assets could not be deleted Audit refresh unavailable')).toBeTruthy())
    expect(await redis.exists('upload:goons:old.vrm')).toBe(true)
    expect(await redis.exists('upload:goon_scenes:lost.jpg')).toBe(true)
  }, 60_000)
})
