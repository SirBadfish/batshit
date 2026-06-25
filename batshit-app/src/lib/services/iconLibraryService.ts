import type { CustomIconDisplaySettings, CustomIconRecord, IconLibraryPrefs, IconRef } from '$lib/icons/iconTypes'

export type OnlineIconProviderId = 'lobe-icons' | 'simple-icons'

export interface OnlineIconCandidate {
  provider: OnlineIconProviderId
  providerLabel: string
  id: string
  slug: string
  title: string
  previewSvg?: string
  brandHex?: string
  sourceUrl?: string
  licenseType?: string
  licenseUrl?: string
  guidelinesUrl?: string
}

export interface IconLibrarySnapshot {
  icons: CustomIconRecord[]
  prefs: IconLibraryPrefs
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const rawBody = await response.text()
  let body: any = {}
  if (rawBody) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = { error: rawBody.trim() }
    }
  }
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Icon request failed with ${response.status}`)
  }
  return body as T
}

export const iconLibraryService = {
  async list(): Promise<IconLibrarySnapshot> {
    return parseJsonResponse<IconLibrarySnapshot>(await fetch('/api/icons/library'))
  },

  async upload(file: File, options: { name?: string; tags?: string[] } = {}): Promise<CustomIconRecord> {
    const form = new FormData()
    form.set('file', file)
    if (options.name?.trim()) form.set('name', options.name.trim())
    if (options.tags?.length) form.set('tags', options.tags.join(','))

    const response = await parseJsonResponse<{ icon: CustomIconRecord }>(
      await fetch('/api/icons/library', {
        method: 'POST',
        body: form
      })
    )
    return response.icon
  },

  async updatePrefs(prefs: IconLibraryPrefs): Promise<IconLibraryPrefs> {
    const response = await parseJsonResponse<{ prefs: IconLibraryPrefs }>(
      await fetch('/api/icons/library', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs })
      })
    )
    return response.prefs
  },

  async update(
    iconId: string,
    updates: { name?: string; tags?: string[]; display?: CustomIconDisplaySettings | null }
  ): Promise<CustomIconRecord> {
    const response = await parseJsonResponse<{ icon: CustomIconRecord }>(
      await fetch(`/api/icons/library/${encodeURIComponent(iconId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
    )
    return response.icon
  },

  async delete(iconId: string): Promise<void> {
    await parseJsonResponse<{ ok: true }>(
      await fetch(`/api/icons/library/${encodeURIComponent(iconId)}`, {
        method: 'DELETE'
      })
    )
  },

  async addRecent(iconRef: IconRef, prefs: IconLibraryPrefs): Promise<IconLibraryPrefs> {
    const key = JSON.stringify(iconRef)
    const recents = [iconRef, ...prefs.recents.filter((entry) => JSON.stringify(entry) !== key)].slice(0, 40)
    return iconLibraryService.updatePrefs({
      ...prefs,
      recents
    })
  },

  async searchOnline(options: {
    query: string
    providers?: OnlineIconProviderId[]
    limit?: number
  }): Promise<OnlineIconCandidate[]> {
    const params = new URLSearchParams()
    params.set('q', options.query)
    if (options.providers?.length) params.set('providers', options.providers.join(','))
    if (options.limit) params.set('limit', String(options.limit))

    const response = await parseJsonResponse<{ icons: OnlineIconCandidate[] }>(
      await fetch(`/api/icons/online/search?${params.toString()}`)
    )
    return response.icons
  },

  async importOnline(candidate: Pick<OnlineIconCandidate, 'provider' | 'slug'>): Promise<CustomIconRecord> {
    const response = await parseJsonResponse<{ icon: CustomIconRecord }>(
      await fetch('/api/icons/online/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(candidate)
      })
    )
    return response.icon
  }
}
