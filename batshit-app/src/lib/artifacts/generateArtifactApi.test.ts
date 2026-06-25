import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BATSHIT_THEME_CSS, generateArtifactApiScript } from './generateArtifactApi'

function installArtifactApi() {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = generateArtifactApiScript({
    artifactId: 'artifact_builder_test',
    artifactName: 'Builder Test',
    runtimeToken: `art_rt_${'a'.repeat(64)}`
  })
  const script = wrapper.querySelector('script')
  if (!script?.textContent) {
    throw new Error('Artifact API script was not generated')
  }
  new Function(script.textContent)()
  return (window as unknown as { batshit: any }).batshit
}

describe('generated artifact builder kit API', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    vi.stubGlobal('fetch', vi.fn())
    delete (window as unknown as { batshit?: unknown }).batshit
  })

  it('injects artifact theme tokens from the launch Batshit palette', () => {
    expect(BATSHIT_THEME_CSS).toContain('--batshit-accent: oklch(0.5 0.044 281)')
    expect(BATSHIT_THEME_CSS).toContain('--batshit-field: oklch(0.54 0.044 281 / 0.22)')
    expect(BATSHIT_THEME_CSS).toContain('--batshit-field-focus-ring')
    expect(BATSHIT_THEME_CSS).toContain('html body :is(input:not([type="checkbox"])')
    expect(BATSHIT_THEME_CSS).toContain('min-height: 40px !important')
    expect(BATSHIT_THEME_CSS).toContain('appearance: none !important')
    expect(BATSHIT_THEME_CSS).toContain('option:checked')
    expect(BATSHIT_THEME_CSS).toContain(':is(button, input[type="button"], input[type="submit"], input[type="reset"])')
    expect(BATSHIT_THEME_CSS).toContain('batshit-unstyled')
    expect(BATSHIT_THEME_CSS).not.toContain('--batshit-accent: #f97316')
    expect(BATSHIT_THEME_CSS).not.toContain('--batshit-accent-hover: #ea580c')
  })

  it('ships Builder Kit form controls with softer panel and field styling', () => {
    const script = generateArtifactApiScript({
      artifactId: 'artifact_builder_test',
      artifactName: 'Builder Test',
      runtimeToken: `art_rt_${'a'.repeat(64)}`
    })

    expect(script).toContain('className = \'batshit-builder-root\'')
    expect(script).toContain('color-mix(in oklab,var(--batshit-surface-elevated) 86%,var(--batshit-primary) 14%)')
    expect(script).toContain('.batshit-builder-input,.batshit-builder-select,.batshit-builder-number{min-height:40px;}')
    expect(script).toContain('.batshit-builder-select{-webkit-appearance:none;appearance:none')
    expect(script).toContain('.batshit-builder-select option:checked')
    expect(script).toContain('.batshit-builder-select option')
    expect(script).toContain('box-shadow:0 0 0 2px var(--batshit-field-focus-ring)')
  })

  it('returns form components as DOM nodes with compatibility handles', () => {
    const batshit = installArtifactApi()
    document.body.innerHTML = '<div id="controlContainer"></div>'

    const onChange = vi.fn()
    const moodSelectComponent = batshit.builder.form.select({
      label: 'Select Mood Manually',
      options: ['Calm', 'Focused', 'Chaotic'],
      value: 'Calm',
      fabricId: 'current-mood',
      onChange
    })

    expect(moodSelectComponent).toBeInstanceOf(HTMLElement)
    expect(moodSelectComponent.shell).toBe(moodSelectComponent)
    expect(moodSelectComponent.input).toBeInstanceOf(HTMLSelectElement)

    document.getElementById('controlContainer')?.appendChild(moodSelectComponent)

    const selectEl = moodSelectComponent.querySelector('select')
    expect(selectEl).toBe(moodSelectComponent.input)
    expect(selectEl?.value).toBe('Calm')

    moodSelectComponent.input.value = 'Focused'
    moodSelectComponent.input.dispatchEvent(new Event('change'))

    expect(onChange).toHaveBeenCalledWith('Focused', expect.any(Event))
  })

  it('mounts standard controls directly or through their shell handle', () => {
    const batshit = installArtifactApi()
    const root = document.createElement('div')
    const legacyRoot = document.createElement('div')

    const actions = batshit.builder.action.standardControls({
      share: false,
      save: false,
      download: false
    })

    expect(actions).toBeInstanceOf(HTMLElement)
    expect(actions.shell).toBe(actions)
    expect(actions.buttons).toMatchObject({
      shareToChat: null,
      saveToClipVault: null,
      download: null
    })

    expect(batshit.builder.mount(root, actions)).toBe(actions)
    expect(root.firstElementChild).toBe(actions)

    const legacyComponent = { shell: document.createElement('span') }
    expect(batshit.builder.mount(legacyRoot, legacyComponent)).toBe(legacyComponent.shell)
    expect(legacyRoot.firstElementChild).toBe(legacyComponent.shell)
  })

  it('automatically attaches the runtime token only to Batshit artifact API fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    installArtifactApi()

    await window.fetch('/api/artifacts/comfyui/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    await window.fetch('/api/artifacts/run-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    await window.fetch('/api/artifacts/clip-sources?artifactId=artifact_builder_test')
    await window.fetch('https://example.com/api/artifacts/comfyui/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const batshitInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const batshitHeaders = new Headers(batshitInit.headers)
    expect(batshitHeaders.get('Authorization')).toBe(`Bearer art_rt_${'a'.repeat(64)}`)
    expect(batshitInit.credentials).toBe('omit')

    const runEventInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const runEventHeaders = new Headers(runEventInit.headers)
    expect(runEventHeaders.get('Authorization')).toBe(`Bearer art_rt_${'a'.repeat(64)}`)
    expect(runEventInit.credentials).toBe('omit')

    const clipSourcesInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    const clipSourcesHeaders = new Headers(clipSourcesInit.headers)
    expect(clipSourcesHeaders.get('Authorization')).toBe(`Bearer art_rt_${'a'.repeat(64)}`)
    expect(clipSourcesInit.credentials).toBe('omit')

    const externalInit = fetchMock.mock.calls[3]?.[1] as RequestInit
    const externalHeaders = new Headers(externalInit.headers)
    expect(externalHeaders.get('Authorization')).toBeNull()
  })

  it('loads and resolves Clip Vault image sources through artifact runtime auth', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sources: [{ id: 'clip_1', filename: 'result.jpg' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            source: {
              type: 'url',
              clipId: 'clip_1',
              filename: 'result.jpg',
              url: 'https://fresh-tunnel.example/uploads/images/result.jpg'
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()

    await expect(batshit.listClipSources()).resolves.toEqual([
      { id: 'clip_1', filename: 'result.jpg' }
    ])
    await expect(batshit.resolveClipSource('clip_1')).resolves.toMatchObject({
      type: 'url',
      clipId: 'clip_1',
      url: 'https://fresh-tunnel.example/uploads/images/result.jpg'
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/artifacts/clip-sources?artifactId=artifact_builder_test'
    )
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/artifacts/clip-sources')
    const resolveInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const resolvePayload = JSON.parse(String(resolveInit.body))
    expect(resolvePayload).toEqual({
      artifactId: 'artifact_builder_test',
      clipId: 'clip_1',
      prefer: 'auto'
    })
    expect(new Headers(resolveInit.headers).get('Authorization')).toBe(
      `Bearer art_rt_${'a'.repeat(64)}`
    )
  })

  it('resolves protected ComfyUI media URLs through authenticated runtime fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('image-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectUrl = vi.fn().mockReturnValue('blob:batshit-comfyui-result')
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl
    })

    const batshit = installArtifactApi()
    const mediaUrl = '/api/artifacts/comfyui/view?baseUrl=comfyui_api_desktop&filename=result.png&type=output'
    const displayUrl = await batshit.resolveMediaUrl(mediaUrl)

    expect(displayUrl).toBe('blob:batshit-comfyui-result')
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer art_rt_${'a'.repeat(64)}`)
    expect(init.credentials).toBe('omit')
  })

  it('leaves external media URLs alone when resolving media', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('image-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()

    const externalUrl = 'https://example.com/result.png'
    await expect(batshit.resolveMediaUrl(externalUrl)).resolves.toBe(externalUrl)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
