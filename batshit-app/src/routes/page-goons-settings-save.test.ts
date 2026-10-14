import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { installUserSettingsRoutes, loadUserSettingsRoute, storedUserSettings } from '$lib/test-utils/userSettingsRoute'
import { persistGoonsSettingsPatchRequest } from '$lib/services/goonsSettingsPersistence'
import { confirmUserSettings, failUserSettingsRead, getUserSettings, getUserSettingsReadState, resetUserSettings, setUserSettings } from '$lib/stores/userSettings.svelte'
import { normalizeDesktopGoonPreferences } from '$lib/goons/resolve'

useRedisTestServer()

// Execute the actual page function bodies. This avoids replacing the enormous page and its
// native-window listeners with a duplicate save implementation; fetch still uses the real route.
function pageSave(name: string, dependencies: Record<string, unknown>) {
  const source = readFileSync('src/routes/+page.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0]
  const file = ts.createSourceFile('page.ts', source, ts.ScriptTarget.Latest, true)
  const fn = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!fn) throw new Error(`Missing page function: ${name}`)
  const js = ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(dependencies), `${js}; return ${name}`)(...Object.values(dependencies)) as (patch: any) => Promise<void>
}

const USER = 'bl975-page-writers'
const SAVED = {
  displayName: 'Authoritative server name',
  goons_settings: {
    dockOpen: true, immersiveMode: false,
    desktop: { fullHeight: false, normalizedWidth: 0.8, stayOnTop: true, clickThrough: false, controlsShortcut: 'CommandOrControl+Alt+K', workspace: 'current-workspace' },
    kitchen: { scenes: { saved: { name: 'Saved scene' } } },
    globalCloset: { items: { saved: { name: 'Saved coat' } } }
  }
}
let route: Awaited<ReturnType<typeof loadUserSettingsRoute>>
let posts: Array<{ body: Record<string, any> }>
let applyLive: ReturnType<typeof vi.fn>
let toastError: ReturnType<typeof vi.fn>

beforeAll(async () => { route = await loadUserSettingsRoute() })
beforeEach(async () => {
  resetUserSettings()
  await redis.updateUserSettings(USER, structuredClone(SAVED) as any)
  posts = installUserSettingsRoutes({ userId: USER, route }).posts
  applyLive = vi.fn()
  toastError = vi.fn()
})
afterEach(() => { resetUserSettings(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function writer(name: string) {
  return pageSave(name, {
    fetch, persistGoonsSettingsPatchRequest, getUserSettingsReadState, getUserSettings,
    confirmUserSettings, setUserSettings, normalizeDesktopGoonPreferences,
    desktopGoonPreferences: normalizeDesktopGoonPreferences({ fullHeight: false }),
    applyDesktopGoonPreferencesLive: applyLive, toast: { error: toastError }
  })
}

describe('page Goon saves (BL-975 D3, D5, D6)', () => {
  it.each(['unread', 'failed'] as const)('Dock/immersive saves do not write while %s', async (state) => {
    if (state === 'failed') failUserSettingsRead(new Error('read failed'))
    await writer('updateGoonsSettings')({ dockOpen: false })
    expect(posts).toEqual([])
    expect(toastError).toHaveBeenCalledOnce()
    expect(await storedUserSettings(USER)).toMatchObject(SAVED)
  })

  it.each(['unread', 'failed'] as const)('Desktop Controls saves refuse before writing while %s', async (state) => {
    if (state === 'failed') failUserSettingsRead(new Error('read failed'))
    await expect(writer('persistDesktopControlsPreferences')({ fullHeight: true })).rejects.toThrow('could not load')
    expect(posts).toEqual([])
    expect(applyLive).not.toHaveBeenCalled()
    expect(await storedUserSettings(USER)).toMatchObject(SAVED)
  })

  it('Desktop Controls sends only the changed key, keeps siblings and installs the full server answer', async () => {
    confirmUserSettings({ displayName: 'Old tab name', goons_settings: { desktop: { fullHeight: false } } } as any)
    await writer('persistDesktopControlsPreferences')({ fullHeight: true })
    expect(posts.map((post) => post.body)).toEqual([{ goons_settings_patch: { desktop: { fullHeight: true } } }])
    const expected = { ...SAVED, goons_settings: { ...SAVED.goons_settings, desktop: { ...SAVED.goons_settings.desktop, fullHeight: true } } }
    expect(await storedUserSettings(USER)).toMatchObject(expected)
    expect(getUserSettings()).toMatchObject(expected)
    expect(applyLive).toHaveBeenCalledWith(normalizeDesktopGoonPreferences(expected.goons_settings.desktop as any))
  })

  it('Dock/immersive saves install server fields beyond the edited Goon section', async () => {
    confirmUserSettings({ displayName: 'Old tab name', goons_settings: { dockOpen: true } })
    await writer('updateGoonsSettings')({ dockOpen: false })
    expect(posts.map((post) => post.body)).toEqual([{ goons_settings_patch: { dockOpen: false } }])
    expect(getUserSettings()).toMatchObject({ ...SAVED, goons_settings: { ...SAVED.goons_settings, dockOpen: false } })
  })
})
