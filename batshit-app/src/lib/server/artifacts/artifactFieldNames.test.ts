import { describe, expect, it } from 'vitest'

import {
  buildFieldNameAdvisory,
  buildFieldNameRefusalMessage,
  buildFieldNameRequiredMessage,
  checkArtifactFieldNames,
  findUnnamedArtifactFields
} from './artifactFieldNames'

// BL-89: a field a screen reader cannot name is a field some people cannot use. These tests pin
// which sources count as a name (a linked or wrapping label, aria-label, aria-labelledby, and title
// last), which never do (a placeholder, a label that merely sits beside the field), and which
// controls are exempt (hidden inputs and buttons).

function page(body: string, script = ''): string {
  return `<!doctype html><html><body>${body}<script>${script}</script></body></html>`
}

function unnamedElements(content: string): string[] {
  return findUnnamedArtifactFields(content).map((field) => field.element)
}

describe('findUnnamedArtifactFields: static markup', () => {
  it('names a field through a linked label, a wrapping label, aria-label, aria-labelledby, or title', () => {
    const content = page(`
      <label for="bill">Bill Amount ($)</label><input type="number" id="bill">
      <label>Tip Percent <input type="range" min="0" max="30"></label>
      <select aria-label="Tip style"><option>Even</option></select>
      <h2 id="note-heading">Note</h2><textarea aria-labelledby="note-heading"></textarea>
      <input type="text" title="Search the docs">
    `)
    expect(unnamedElements(content)).toEqual([])
  })

  it('flags the BL-89 fields: a title beside the field, or a placeholder, is not a name', () => {
    const content = page(`
      <div class="form-group"><label>Bill Amount ($)</label><input type="number" id="bill-amount"></div>
      <div class="form-group"><span>Tip Percent (%)</span><input type="range" id="tip-percent" min="0" max="30"></div>
      <input type="text" placeholder="e.g. Vercel AI SDK">
      <select id="style"><option>A</option></select>
      <textarea placeholder="Paste text"></textarea>
    `)
    expect(unnamedElements(content)).toEqual([
      '<input type="number" id="bill-amount">',
      '<input type="range" id="tip-percent">',
      '<input type="text">',
      '<select id="style">',
      '<textarea>'
    ])
  })

  it('does not accept a label, aria-label, or aria-labelledby that carries no text or points at nothing', () => {
    const content = page(`
      <label for="a"></label><input id="a">
      <label><input id="b"></label>
      <input id="c" aria-label="  ">
      <input id="d" aria-labelledby="missing-heading">
      <input id="e" title="">
    `)
    expect(unnamedElements(content)).toEqual([
      '<input id="a">',
      '<input id="b">',
      '<input id="c">',
      '<input id="d">',
      '<input id="e">'
    ])
  })

  it('exempts hidden inputs, buttons, and fields that are not shown at all', () => {
    const content = page(`
      <input type="hidden" name="token">
      <input type="submit" value="Go"><input type="button" value="Run"><input type="reset"><input type="image" src="x.png" alt="Go">
      <input type="file" hidden>
      <input type="file" style="display: none">
      <input type="text" aria-hidden="true" tabindex="-1">
    `)
    expect(unnamedElements(content)).toEqual([])
  })

  it('still checks a field whose container starts hidden, because a script shows it later', () => {
    const content = page('<div id="paste-group" style="display:none"><label>Paste Content</label><textarea id="add-text"></textarea></div>')
    expect(unnamedElements(content)).toEqual(['<textarea id="add-text">'])
  })

  it('ignores markup inside scripts, styles, and comments', () => {
    const content = page(
      `<!-- <input id="commented-out"> --><style>input[type="text"] { color: red; }</style>`,
      `container.innerHTML = '<input id="built-by-script">';`
    )
    expect(unnamedElements(content)).toEqual([])
  })

  it('reports the line each unnamed field is on', () => {
    const content = ['<!doctype html>', '<body>', '<label>Bill</label>', '<input id="bill">', '</body>'].join('\n')
    expect(findUnnamedArtifactFields(content)).toMatchObject([{ source: 'markup', line: 4, element: '<input id="bill">' }])
  })
})

describe('findUnnamedArtifactFields: Builder Kit calls', () => {
  it('accepts Builder Kit fields that pass a label or an ariaLabel (the Builder Kit links them)', () => {
    const content = page('', `
      const b = window.batshit.builder;
      b.form.number({ label: 'Bill Amount ($)', fabricId: 'bill-amount' });
      b.form.slider({ label: 'Source image ' + (index + 1), min: 0, max: 30 });
      window.batshit.builder.form.text({ ariaLabel: 'Search the docs', placeholder: 'Search' });
      builder.form.select({ label, options: ['a', 'b'] });
    `)
    expect(unnamedElements(content)).toEqual([])
  })

  it('flags text, textarea, select, multiselect, slider, and number calls with no label', () => {
    const content = page('', `
      builder.form.text({ placeholder: 'Name' });
      builder.form.textarea({ fabricId: 'prompt' });
      builder.form.select({ options: [{ label: 'A', value: 'a' }], fabricId: 'style' });
      builder.form.multiselect({ label: '', options: ['x'] });
      builder.form.slider({ fabricId: 'tip-percent', min: 0, max: 30 });
      builder.form.number({ label: null, fabricId: 'bill-amount' });
    `)
    expect(unnamedElements(content)).toEqual([
      'builder.form.text()',
      "builder.form.textarea({ fabricId: 'prompt' })",
      "builder.form.select({ fabricId: 'style' })",
      'builder.form.multiselect()',
      "builder.form.slider({ fabricId: 'tip-percent' })",
      "builder.form.number({ fabricId: 'bill-amount' })"
    ])
  })

  it('does not guess about calls it cannot read, and leaves self-labelling kinds alone', () => {
    const content = page('', `
      builder.form.text(options);
      builder.form.number({ ...shared, fabricId: 'bill' });
      builder.form.checkbox({ fabricId: 'polish' });
      builder.form.toggle({});
      builder.form.radio({ options: ['a'] });
      builder.form.promptPair({ fabricId: 'prompt' });
    `)
    expect(unnamedElements(content)).toEqual([])
  })
})

describe('checkArtifactFieldNames: a save may not add an unnamed field', () => {
  const saved = page('<label>Bill</label><input id="bill"><select id="style"></select>')

  it('treats every unnamed field of a brand-new artifact as added', () => {
    const check = checkArtifactFieldNames(saved, [])
    expect(check.added.map((field) => field.element)).toEqual(['<input id="bill">', '<select id="style">'])
    expect(check.kept).toEqual([])
  })

  it('keeps fields the artifact already had, so metadata-only saves and edits elsewhere still save', () => {
    const edited = saved.replace('</body>', '<p>New help text</p></body>')
    const check = checkArtifactFieldNames(edited, [saved])
    expect(check.added).toEqual([])
    expect(check.kept.map((field) => field.element)).toEqual(['<input id="bill">', '<select id="style">'])
  })

  it('keeps a field from any saved version, so restoring an older version still saves', () => {
    const current = page('<label for="bill">Bill</label><input id="bill">')
    const check = checkArtifactFieldNames(saved, [current, saved])
    expect(check.added).toEqual([])
  })

  it('flags a new unnamed field and a second copy of an old one', () => {
    const next = saved
      .replace('<input id="bill">', '<input id="bill"><input id="bill">')
      .replace('</body>', '<textarea id="note"></textarea></body>')
    const check = checkArtifactFieldNames(next, [saved])
    expect(check.kept.map((field) => field.element)).toEqual(['<input id="bill">', '<select id="style">'])
    expect(check.added.map((field) => field.element)).toEqual(['<input id="bill">', '<textarea id="note">'])
  })

  // Review of BL-89: "added" must mean a new field, not an edited one. A field is matched with the
  // saved versions by a stable identity where it has one (markup id or name; Builder Kit fabricId
  // or id), and by its text only when it has none.
  describe('an old unnamed field the save edits is still the same field', () => {
    const oldMarkup = page('<input type="number" id="bill" class="field" min="0">')
    const oldBuilder = page(
      '<div id="app"></div>',
      "const builder = window.batshit.builder; builder.mount(app, builder.form.slider({ fabricId: 'tip-percent', min: 0, max: 30, onChange: (v) => { state.tip = v } }))"
    )

    it.each([
      ['a class change', oldMarkup.replace('class="field"', 'class="field wide"')],
      ['reordered attributes', oldMarkup.replace('<input type="number" id="bill" class="field" min="0">', '<input min="0" class="field" id="bill" type="number">')],
      ['a new min', oldMarkup.replace('min="0"', 'min="1"')]
    ])('markup: %s', (_label, next) => {
      const check = checkArtifactFieldNames(next, [oldMarkup])
      expect(check.added).toEqual([])
      expect(check.kept.map((field) => field.element)).toEqual(['<input type="number" id="bill">'])
    })

    it.each([
      ['an onChange edit', oldBuilder.replace('state.tip = v', 'state.tip = Number(v)')],
      ['a new min', oldBuilder.replace('min: 0', 'min: 5')],
      [
        'a reformatted options object',
        oldBuilder.replace(
          "{ fabricId: 'tip-percent', min: 0, max: 30, onChange: (v) => { state.tip = v } }",
          '{\n  max: 30,\n  min: 0,\n  fabricId: "tip-percent",\n  onChange: (v) => { state.tip = v },\n}'
        )
      ]
    ])('Builder Kit: %s', (_label, next) => {
      const check = checkArtifactFieldNames(next, [oldBuilder])
      expect(check.added).toEqual([])
      expect(check.kept).toHaveLength(1)
    })

    it('a Builder Kit field with an id and no fabricId is matched by its id', () => {
      const saved = page('', "builder.form.text({ id: 'search', placeholder: 'Search' })")
      const edited = page('', "builder.form.text({ placeholder: 'Search the docs', id: 'search' })")
      expect(checkArtifactFieldNames(edited, [saved]).added).toEqual([])
    })

    it('a genuinely new unnamed field is still refused, and a field with no identity is matched by its text', () => {
      const withNew = oldMarkup.replace('</body>', '<input type="number" id="tip"></body>')
      expect(checkArtifactFieldNames(withNew, [oldMarkup]).added.map((field) => field.element)).toEqual([
        '<input type="number" id="tip">'
      ])

      const anonymous = page('<input type="number" class="a">')
      expect(checkArtifactFieldNames(anonymous, [anonymous]).added).toEqual([])
      expect(checkArtifactFieldNames(anonymous.replace('class="a"', 'class="b"'), [anonymous]).added).toHaveLength(1)
    })
  })
})

describe('field name messages', () => {
  it('names each field and says how to fix it, for the agent and for Settings', () => {
    const [field] = findUnnamedArtifactFields(page('<label>Bill</label><input type="number" id="bill">'))
    const message = buildFieldNameRequiredMessage([field])
    expect(message).toContain('<input type="number" id="bill">')
    expect(message).toContain('<label for=')
    expect(message).toContain('aria-label')
    expect(message).toContain('ariaLabel')
    expect(message).toContain('placeholder is not a name')
    expect(buildFieldNameAdvisory([field])).toContain('<input type="number" id="bill">')
  })

  it('the refusal names the fields and how to name them, with no advice to switch enforcement off', () => {
    const [field] = findUnnamedArtifactFields(page('<label>Bill</label><input type="number" id="bill">'))
    const refusal = buildFieldNameRefusalMessage([field])
    expect(refusal.startsWith('Artifact save blocked: ')).toBe(true)
    expect(refusal).toContain('<input type="number" id="bill">')
    expect(refusal).toContain('aria-label')
    expect(refusal).not.toMatch(/toggle|Enforce Batshit Artifact Structure|Settings/)
  })

  it('lists at most six fields and counts the rest', () => {
    const inputs = Array.from({ length: 9 }, (_, index) => `<input id="f${index}">`).join('')
    const message = buildFieldNameRequiredMessage(findUnnamedArtifactFields(page(inputs)))
    expect(message).toContain('<input id="f5">')
    expect(message).not.toContain('<input id="f6">')
    expect(message).toContain('and 3 more')
  })
})
