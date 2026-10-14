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
    // The primary's values are pinned against app.css in artifactThemeAppTokens.test.ts (BL-99).
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

  it.each(['video', 'audio'])('honors explicit controls choices for %s output', (type) => {
    const batshit = installArtifactApi()
    const root = document.createElement('div')
    document.body.appendChild(root)

    for (const [options, expectedControls] of [
      [{ type }, true],
      [{ type, controls: true }, true],
      [{ type, controls: false }, false]
    ] as const) {
      const component = batshit.builder.output.media('data:application/octet-stream;base64,AA==', options)
      expect(batshit.builder.mount(root, component)).toBe(component)
      expect(component.shell).toBe(component)
      const media = component.querySelector(type) as HTMLMediaElement
      expect(media).toBeInstanceOf(HTMLMediaElement)
      expect(media.controls).toBe(expectedControls)
      expect(media.hasAttribute('controls')).toBe(expectedControls)
      expect(media.getAttribute('src')).toBe('data:application/octet-stream;base64,AA==')
      expect(media.style.maxWidth).toBe('100%')
    }
  })

  it('keeps image output independent of media controls', () => {
    const batshit = installArtifactApi()
    for (const options of [{}, { type: 'image', controls: false, alt: 'Preview' }]) {
      const component = batshit.builder.output.media('data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==', options)
      const image = component.querySelector('img')
      expect(image).toBeInstanceOf(HTMLImageElement)
      expect(image.alt).toBe('alt' in options ? options.alt : 'artifact output')
      expect(image.hasAttribute('controls')).toBe(false)
      expect(component.shell).toBe(component)
    }
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

  // BL-89: a Builder Kit field used to show its label beside the control without linking the two,
  // so every field in every artifact reached a screen reader with no name.
  it('hands a chosen or dropped file to onFiles, the documented name, and still to onChange', () => {
    const batshit = installArtifactApi()
    const file = new File(['x'], 'receipt.png', { type: 'image/png' })
    // A FileList-like object, not an array, as a real file input gives.
    const choose = (input: HTMLInputElement) => {
      Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true })
      input.dispatchEvent(new Event('change'))
    }

    const dropped = vi.fn()
    const drop = batshit.builder.form.dropFile({ label: 'Drop', onFiles: dropped })
    choose(drop.input)
    expect(dropped).toHaveBeenCalledWith([file], expect.any(Event))

    const uploaded = vi.fn()
    const upload = batshit.builder.form.uploadButton({ label: 'Upload', onFiles: uploaded })
    choose(upload.input)
    expect(uploaded).toHaveBeenCalledWith([file], expect.any(Event))

    const withButton = vi.fn()
    const dropWithButton = batshit.builder.form.dropFile({ label: 'Drop', showUploadButton: true, onFiles: withButton })
    choose(dropWithButton.shell.querySelector('input[type="file"]'))
    expect(withButton).toHaveBeenCalledTimes(1)

    const legacy = vi.fn()
    choose(batshit.builder.form.dropFile({ label: 'Drop', onChange: legacy }).input)
    expect(legacy).toHaveBeenCalledWith([file], expect.any(Event))
  })

  it('links every Builder Kit field to its visible label so a screen reader can name it', () => {
    const batshit = installArtifactApi()
    const fields: Array<[any, string]> = [
      [batshit.builder.form.number({ label: 'Bill Amount ($)', fabricId: 'bill-amount' }), 'Bill Amount ($)'],
      [batshit.builder.form.slider({ label: 'Tip Percent (%)', min: 0, max: 30, value: 18, fabricId: 'tip-percent' }), 'Tip Percent (%)'],
      [batshit.builder.form.text({ label: 'Name' }), 'Name'],
      [batshit.builder.form.textarea({ label: 'Note' }), 'Note'],
      [batshit.builder.form.select({ label: 'Style', options: ['A', 'B'] }), 'Style'],
      [batshit.builder.form.multiselect({ label: 'Tags', options: ['x', 'y'] }), 'Tags']
    ]
    for (const [component] of fields) document.body.appendChild(component)

    const ids = new Set<string>()
    for (const [component, text] of fields) {
      const control = component.input as HTMLInputElement
      expect(control.id).not.toBe('')
      ids.add(control.id)
      expect(Array.from(control.labels ?? []).map((label) => label.textContent)).toEqual([text])
    }
    expect(ids.size).toBe(fields.length)
  })

  it('never hands a field an id the page already uses', () => {
    document.body.innerHTML = '<input id="batshit-field-1" aria-label="The artifact’s own field">'
    const batshit = installArtifactApi()
    const bill = batshit.builder.form.number({ label: 'Bill' })
    document.body.appendChild(bill)

    expect(bill.input.id).not.toBe('batshit-field-1')
    expect(document.querySelectorAll(`[id="${bill.input.id}"]`)).toHaveLength(1)
    expect(Array.from(bill.input.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent)).toEqual(['Bill'])
  })

  it('keeps an id the artifact chose, and names a field with no visible label through ariaLabel', () => {
    const batshit = installArtifactApi()
    const chosen = batshit.builder.form.number({ label: 'Bill', id: 'bill-input' })
    const search = batshit.builder.form.text({ ariaLabel: 'Search the docs', placeholder: 'Search' })
    document.body.append(chosen, search)

    expect(chosen.input.id).toBe('bill-input')
    expect(Array.from(chosen.input.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent)).toEqual(['Bill'])
    expect(search.input.getAttribute('aria-label')).toBe('Search the docs')
    expect(search.querySelector('label')).toBeNull()
  })

  // Review of BL-89: builder-kit-api.md promises an explicit `id` on every field, and textarea,
  // select, and multiselect ignored it (checkbox too, and a radio group or prompt pair had no id).
  it('keeps an id the artifact chose on every kind of field, and links the label to it', () => {
    const batshit = installArtifactApi()
    const linked: Array<[any, string]> = [
      [batshit.builder.form.text({ label: 'Name', id: 'pick-text' }), 'pick-text'],
      [batshit.builder.form.textarea({ label: 'Note', id: 'pick-textarea' }), 'pick-textarea'],
      [batshit.builder.form.select({ label: 'Style', options: ['A', 'B'], id: 'pick-select' }), 'pick-select'],
      [batshit.builder.form.multiselect({ label: 'Tags', options: ['x', 'y'], id: 'pick-multi' }), 'pick-multi'],
      [batshit.builder.form.number({ label: 'Bill', id: 'pick-number' }), 'pick-number'],
      [batshit.builder.form.slider({ label: 'Tip', min: 0, max: 30, id: 'pick-slider' }), 'pick-slider']
    ]
    const check = batshit.builder.form.checkbox({ label: 'Round up', id: 'pick-check' })
    const radio = batshit.builder.form.radio({ label: 'Size', options: ['S', 'M'], id: 'pick-radio' })
    const pair = batshit.builder.form.promptPair({ label: 'Prompts', id: 'pick-pair' })
    for (const [component] of linked) document.body.appendChild(component)
    document.body.append(check, radio, pair)

    for (const [component, id] of linked) {
      expect(component.input.id, id).toBe(id)
      expect(document.getElementById(id)).toBe(component.input)
      expect((component.querySelector('label.batshit-builder-label') as HTMLLabelElement).htmlFor, id).toBe(id)
    }
    expect(check.input.id).toBe('pick-check')
    expect(document.getElementById('pick-radio')?.getAttribute('role')).toBe('radiogroup')
    expect(document.getElementById('pick-pair')?.getAttribute('role')).toBe('group')
  })

  it('shows a slider value that follows the pointer and the keyboard', () => {
    const batshit = installArtifactApi()
    const tip = batshit.builder.form.slider({
      label: 'Tip Percent',
      min: 0,
      max: 30,
      step: 1,
      value: 18,
      valueSuffix: '%',
      fabricId: 'tip-percent'
    })
    document.body.appendChild(tip)

    const output = tip.querySelector('output') as HTMLOutputElement
    expect(output).not.toBeNull()
    expect(output.textContent).toBe('18%')
    expect(output.getAttribute('for')).toBe(tip.input.id)

    tip.input.value = '15'
    tip.input.dispatchEvent(new Event('input'))
    expect(output.textContent).toBe('15%')

    tip.input.value = '20'
    tip.input.dispatchEvent(new Event('input'))
    expect(output.textContent).toBe('20%')
    // The value sits beside the label, not inside it, so the field's name stays the label alone.
    expect(Array.from(tip.input.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent)).toEqual(['Tip Percent'])
  })

  // A range input clamps and snaps its value to the range and step it has when the value is set,
  // so a value set before min/max/step was bent to the default 0-100, step 1.
  it('starts a slider at its value when that value lies outside 0-100 or between whole steps', () => {
    const batshit = installArtifactApi()
    const width = batshit.builder.form.slider({ label: 'Width', min: 256, max: 2048, step: 64, value: 1024 })
    const strength = batshit.builder.form.slider({ label: 'Strength', min: 0, max: 2, step: 0.05, value: 0.8 })
    document.body.append(width, strength)

    expect(width.input.value).toBe('1024')
    expect(width.querySelector('output')?.textContent).toBe('1024')
    expect(strength.input.value).toBe('0.8')
    expect(strength.querySelector('output')?.textContent).toBe('0.8')
  })

  it('gives a slider its min, max, and step before its value (Chrome snaps 0.8 to 1 on a step-1 input)', () => {
    // jsdom clamps a range value to min/max but does not snap it to the step as Chrome does
    // (Chrome: 0.8 set before `step = 0.05` reads back as "1"), so record the input's bounds at
    // the moment its value is assigned.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    const seen: Array<{ min: string; max: string; step: string }> = []
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get: descriptor.get,
      set(this: HTMLInputElement, next: string) {
        if (this.type === 'range') seen.push({ min: this.min, max: this.max, step: this.step })
        descriptor.set!.call(this, next)
      }
    })
    try {
      const batshit = installArtifactApi()
      batshit.builder.form.slider({ label: 'Strength', min: 0, max: 2, step: 0.05, value: 0.8 })
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'value', descriptor)
    }
    expect(seen[0]).toEqual({ min: '0', max: '2', step: '0.05' })
  })

  it('has a screen reader say a slider value once, with its unit', () => {
    const batshit = installArtifactApi()
    const tip = batshit.builder.form.slider({ label: 'Tip Percent', min: 0, max: 30, value: 18, valueSuffix: '%', fabricId: 'tip-percent' })
    const plain = batshit.builder.form.slider({ label: 'Steps', min: 1, max: 20, value: 8 })
    document.body.append(tip, plain)

    // The readout is for the eye; the slider itself reports its value, so the readout is not a
    // second live region that would repeat every change.
    expect(tip.querySelector('output')?.getAttribute('aria-hidden')).toBe('true')
    expect(tip.input.getAttribute('aria-valuetext')).toBe('18%')
    tip.input.value = '15'
    tip.input.dispatchEvent(new Event('input'))
    expect(tip.input.getAttribute('aria-valuetext')).toBe('15%')
    // With no unit the number itself is already right.
    expect(plain.input.hasAttribute('aria-valuetext')).toBe(false)
  })

  // BL-175: nothing in Batshit sends `batshit:set-fields` (an agent's run happens on the server and
  // never fills an open panel), so the page no longer listens for it or keeps a setter per field.
  it('ignores a batshit:set-fields message: nothing sends it, so no field listens for one', () => {
    const batshit = installArtifactApi()
    const onChange = vi.fn()
    const tip = batshit.builder.form.slider({ label: 'Tip Percent', min: 0, max: 30, value: 18, fabricId: 'tip-percent', onChange })
    const note = batshit.builder.form.text({ label: 'Note', value: 'hello', fabricId: 'note', onChange })
    const pick = batshit.builder.form.select({ label: 'Pick', options: ['a', 'b'], value: 'a', fabricId: 'pick', onChange })
    document.body.append(tip, note, pick)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'batshit:set-fields', fields: { 'tip-percent': 22, note: 'changed', pick: 'b' } }
      })
    )

    expect(tip.input.value).toBe('18')
    expect(note.input.value).toBe('hello')
    expect(pick.input.value).toBe('a')
    expect(onChange).not.toHaveBeenCalled()
    expect(batshit._fabricSetters).toBeUndefined()
    // The field manifest itself stays: Batshit saves it as metadata.fabric_fields.
    expect(batshit.getFabricFields().map((field: { fabricId: string }) => field.fabricId)).toEqual(['tip-percent', 'note', 'pick'])
  })

  it('names a radio group and a prompt pair by their labels', () => {
    const batshit = installArtifactApi()
    const size = batshit.builder.form.radio({ label: 'Size', options: ['Small', 'Large'], value: 'Small' })
    const pair = batshit.builder.form.promptPair({ label: 'Prompts' })
    document.body.append(size, pair)

    const group = size.input as HTMLElement
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Size')

    const pairGroup = pair.querySelector('[role="group"]') as HTMLElement
    expect(pairGroup).not.toBeNull()
    expect(document.getElementById(pairGroup.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Prompts')
    expect(Array.from(pair.input.prompt.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent)).toEqual(['Prompt'])
  })

  // BL-171: builder-kit-api.md documented option names the kit ignored. Two of Josh's artifacts pass
  // `checked` to toggle(), so their toggles started off. The documented names are now aliases of the
  // names the code reads; the canonical name wins when both are given.
  describe('documented option names (BL-171)', () => {
    it('starts a checkbox or toggle on from `checked`, and `value` wins when both are given', () => {
      const batshit = installArtifactApi()
      const polish = batshit.builder.form.toggle({ label: 'Polish prompt automatically', checked: true, fabricId: 'enhance-prompt' })
      const tick = batshit.builder.form.checkbox({ label: 'Tick', checked: true })
      const both = batshit.builder.form.toggle({ label: 'Both', value: false, checked: true })
      const canonical = batshit.builder.form.toggle({ label: 'Canonical', value: true })
      const neither = batshit.builder.form.toggle({ label: 'Neither' })

      expect(polish.input.checked).toBe(true)
      expect(tick.input.checked).toBe(true)
      expect(both.input.checked).toBe(false)
      expect(canonical.input.checked).toBe(true)
      expect(neither.input.checked).toBe(false)
    })

    it('selects a multiselect from `values`, and `value` wins when both are given', () => {
      const batshit = installArtifactApi()
      const options = ['red', 'green', 'blue']
      const picked = batshit.builder.form.multiselect({ label: 'Colours', options, values: ['red', 'blue'] })
      const both = batshit.builder.form.multiselect({ label: 'Both', options, value: ['green'], values: ['red'] })
      const selected = (component: any) => Array.from(component.input.selectedOptions as HTMLCollectionOf<HTMLOptionElement>).map((option) => option.value)

      expect(selected(picked)).toEqual(['red', 'blue'])
      expect(selected(both)).toEqual(['green'])
    })

    it('colours a status card from `status`, and `kind` wins when both are given', () => {
      const batshit = installArtifactApi()
      expect(batshit.builder.output.statusCard({ title: 'Saved', status: 'success', message: 'Done' }).dataset.kind).toBe('success')
      expect(batshit.builder.output.statusCard({ title: 'Both', kind: 'warning', status: 'error' }).dataset.kind).toBe('warning')
      expect(batshit.builder.output.statusCard({ title: 'Neither' }).dataset.kind).toBe('info')
    })

    it('picks table columns from `headers`, and `columns` wins when both are given', () => {
      const batshit = installArtifactApi()
      const rows = [{ name: 'Ada', role: 'Engineer', secret: 'x' }]
      const headerText = (component: HTMLElement) => Array.from(component.querySelectorAll('th')).map((th) => th.textContent)
      const cellText = (component: HTMLElement) => Array.from(component.querySelectorAll('td')).map((td) => td.textContent)

      const viaHeaders = batshit.builder.output.table(rows, { headers: ['name', 'role'] })
      expect(headerText(viaHeaders)).toEqual(['name', 'role'])
      expect(cellText(viaHeaders)).toEqual(['Ada', 'Engineer'])

      const both = batshit.builder.output.table(rows, { columns: ['role'], headers: ['name'] })
      expect(headerText(both)).toEqual(['role'])

      const neither = batshit.builder.output.table(rows)
      expect(headerText(neither)).toEqual(['name', 'role', 'secret'])
    })

    it('makes a textarea `rows` lines tall, and leaves one without `rows` as it was', () => {
      const batshit = installArtifactApi()
      const tall = batshit.builder.form.textarea({ label: 'Prompt', rows: 7 })
      const typed = batshit.builder.form.textarea({ label: 'Typed', rows: '4' })
      const plain = batshit.builder.form.textarea({ label: 'Notes' })

      // Measured in headless Chrome: the theme's field floor is 40px, so the rows set the height
      // (7 rows: about 149px; none: the browser's 2 rows, about 58px).
      expect(tall.input.rows).toBe(7)
      expect(typed.input.rows).toBe(4)
      expect(plain.input.hasAttribute('rows')).toBe(false)
      // A value that is not a whole number of lines is ignored.
      for (const rows of ['many', 0, -3, 2.5, true]) {
        expect(batshit.builder.form.textarea({ label: 'Odd', rows }).input.hasAttribute('rows'), String(rows)).toBe(false)
      }
    })
  })
})
