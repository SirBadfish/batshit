import { describe, expect, it, vi } from 'vitest'

import {
  DesktopControlsClipError,
  DesktopControlsClipStateController,
  type DesktopControlsFetch,
  type DesktopControlsSessionSource
} from '$lib/services/desktopControlsClips'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

function response(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body
    }
  }
}

function clip(id: string, filename = `${id}.png`) {
  return {
    id,
    user_id: 'user-1',
    filename,
    fileType: 'image',
    mimeType: 'image/png',
    displayUrl: `/uploads/clips/${filename}`,
    localUrl: `/uploads/clips/${filename}`,
    externalTokens: 765,
    localTokens: 765,
    storageMode: 'local',
    created_at: '2026-08-12T00:00:00.000Z',
    systemClip: false
  }
}

function sessionState(sessionId: string, clipIds: string[] = []) {
  return {
    sessionId,
    clips: clipIds.map((clipId) => ({
      clipId,
      attachedAt: '2026-08-12T00:00:00.000Z',
      unclipAfter: null,
      messagesUntilUnclip: null
    }))
  }
}

function sessionSource(initialSessionId: string | null): {
  source: DesktopControlsSessionSource
  set(sessionId: string | null): void
} {
  let current = initialSessionId
  const listeners = new Set<(sessionId: string | null) => void>()
  return {
    source: {
      getCurrentSessionId: () => current,
      subscribe(listener) {
        listener(current)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    set(sessionId) {
      current = sessionId
      for (const listener of listeners) listener(sessionId)
    }
  }
}

describe('Desktop Controls Clip state adapter', () => {
  it('follows the canonical active-session store and loads the existing Clip Vault/session state', async () => {
    const sessions = sessionSource('session-1')
    const fetcher = vi.fn<DesktopControlsFetch>(async (input) => {
      if (input === '/api/clips') return response([clip('clip-1'), clip('clip-2')])
      if (input === '/api/session-clips/state/session-1') {
        return response(sessionState('session-1', ['clip-2']))
      }
      if (input === '/api/session-clips/state/session-2') {
        return response(sessionState('session-2', ['clip-1']))
      }
      return response({ error: 'missing' }, { ok: false, status: 404 })
    })
    const controller = new DesktopControlsClipStateController({
      fetcher,
      sessionSource: sessions.source,
      eventTarget: new EventTarget()
    })

    controller.start()
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'))
    expect(controller.getState()).toMatchObject({
      sessionId: 'session-1',
      attachedClips: [{ id: 'clip-2', attached: true }]
    })

    sessions.set('session-2')
    await vi.waitFor(() => expect(controller.getState().sessionId).toBe('session-2'))
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'))
    expect(controller.getState().attachedClips.map((item) => item.id)).toEqual(['clip-1'])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('attaches and detaches through the canonical session Clip API and publishes live invalidation', async () => {
    let attachedIds: string[] = []
    const events: CustomEvent[] = []
    const eventTarget = new EventTarget()
    eventTarget.addEventListener(LIVE_SETTINGS_EVENTS.sessionClipStateChanged, (event) => {
      events.push(event as CustomEvent)
    })
    const fetcher = vi.fn<DesktopControlsFetch>(async (input, init) => {
      if (input === '/api/clips') return response([clip('clip-1')])
      if (input === '/api/session-clips/state/session-1') {
        return response(sessionState('session-1', attachedIds))
      }
      if (input === '/api/session-clips/state' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          action: string
          clipId: string
        }
        attachedIds = body.action === 'attach' ? [body.clipId] : []
        return response(sessionState('session-1', attachedIds))
      }
      return response({ error: 'missing' }, { ok: false, status: 404 })
    })
    const controller = new DesktopControlsClipStateController({
      fetcher,
      sessionSource: sessionSource(null).source,
      eventTarget
    })
    await controller.setSession('session-1')

    await controller.attach('clip-1')
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      attachedClips: [{ id: 'clip-1', attached: true }]
    })
    await controller.detach('clip-1')
    expect(controller.getState().attachedClips).toEqual([])
    expect(events.map((event) => event.detail)).toEqual([
      { sessionId: 'session-1', clipId: 'clip-1', source: 'runtime' },
      { sessionId: 'session-1', clipId: 'clip-1', source: 'runtime' }
    ])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('refetches once on external canonical invalidation and never polls', async () => {
    let attachedIds: string[] = []
    const eventTarget = new EventTarget()
    const fetcher = vi.fn<DesktopControlsFetch>(async (input) => {
      if (input === '/api/clips') return response([clip('clip-1')])
      return response(sessionState('session-1', attachedIds))
    })
    const controller = new DesktopControlsClipStateController({
      fetcher,
      sessionSource: sessionSource('session-1').source,
      eventTarget
    })
    controller.start()
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'))
    expect(fetcher).toHaveBeenCalledTimes(2)

    attachedIds = ['clip-1']
    eventTarget.dispatchEvent(
      new CustomEvent(LIVE_SETTINGS_EVENTS.sessionClipStateChanged, {
        detail: { sessionId: 'session-1', clipId: 'clip-1', source: 'upload' }
      })
    )
    await vi.waitFor(() => expect(controller.getState().attachedClips).toHaveLength(1))
    expect(fetcher).toHaveBeenCalledTimes(4)
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('surfaces broken references and failed mutations instead of fabricating Clip state', async () => {
    const fetcher = vi.fn<DesktopControlsFetch>(async (input) => {
      if (input === '/api/clips') return response([clip('clip-1')])
      return response(sessionState('session-1', ['missing-clip']))
    })
    const controller = new DesktopControlsClipStateController({
      fetcher,
      sessionSource: sessionSource(null).source,
      eventTarget: new EventTarget()
    })

    await expect(controller.setSession('session-1')).rejects.toMatchObject({
      code: 'BROKEN_CLIP_REFERENCE'
    })
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'BROKEN_CLIP_REFERENCE' }
    })
    await expect(controller.attach('missing-clip')).rejects.toBeInstanceOf(DesktopControlsClipError)
  })

  it('rejects overlapping writes and ignores completed loads after deterministic close', async () => {
    let resolveMutation: ((value: ReturnType<typeof response>) => void) | null = null
    const fetcher = vi.fn<DesktopControlsFetch>(async (input, init) => {
      if (input === '/api/clips') return response([clip('clip-1')])
      if (input.includes('/api/session-clips/state/session-1')) {
        return response(sessionState('session-1'))
      }
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveMutation = resolve
        })
      }
      return response({ error: 'missing' }, { ok: false, status: 404 })
    })
    const controller = new DesktopControlsClipStateController({
      fetcher,
      sessionSource: sessionSource(null).source,
      eventTarget: new EventTarget()
    })
    await controller.setSession('session-1')
    const first = controller.attach('clip-1')
    await expect(controller.detach('clip-1')).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS'
    })
    controller.close()
    resolveMutation?.(response(sessionState('session-1', ['clip-1'])))
    await first
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      sessionId: null
    })
    await expect(controller.refresh()).rejects.toMatchObject({
      code: 'CLOSED'
    })
  })
})
