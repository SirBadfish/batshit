# Builder Kit Reference

**Load when:** you are writing an artifact's UI: every form, output, and action component with its options, how `fabricId` makes a field agent-settable, and the Share / Save / Download bar. Storage, events, saved API keys, and the low-level share call are in `runtime-api.md`; AI calls are in `ai-capabilities.md`.

Builder Kit is Batshit's component library inside the artifact (`window.batshit.builder`). Its parts come with the Batshit theme, focus, hover, disabled, and loading states, and the field names screen readers need. Use it for every normal control; reach for raw HTML only for things it has no part for (a chart, a canvas, a custom visual).

## Layout

- `builder.createRoot(options)`: a themed root container. It is the content body: do not add a second title or header in it (Batshit draws the artifact name, icon, and controls around the page).
- `builder.mount(target, component)`: puts a component into a DOM element. This is the default.

Components are real DOM elements with handles attached: `component.input` is the underlying `<input>`, `<select>`, or `<textarea>`; `component.shell` is the element itself (older `appendChild(component.shell)` code still works); an action bar exposes `actions.buttons`.

## Form components (`builder.form.*`)

| Component | What it is | Key options |
|---|---|---|
| `text(options)` | One-line text box | `label`, `placeholder`, `value`, `onChange`, `fabricId` |
| `textarea(options)` | Multi-line text box | `label`, `placeholder`, `value`, `rows` (height in lines), `onChange`, `fabricId` |
| `select(options)` | Dropdown | `label`, `options[]`, `value`, `onChange`, `fabricId` |
| `multiselect(options)` | Multi-pick dropdown | `label`, `options[]`, `value[]` (or `values[]`), `onChange`, `fabricId` |
| `checkbox(options)` / `toggle(options)` | On/off | `label`, `value` (or `checked`; `true` starts it on), `onChange`, `fabricId` |
| `radio(options)` | Radio group | `label`, `options[]`, `value`, `onChange`, `fabricId` |
| `slider(options)` | Range slider that shows its value beside the label; with no `value` it starts mid-range | `label`, `min`, `max`, `step`, `value`, `valueSuffix` (such as `'%'`), `onChange`, `fabricId` |
| `number(options)` | Number box | `label`, `min`, `max`, `step`, `value`, `onChange`, `fabricId` |
| `promptPair(options)` | Prompt plus negative prompt | `label`, `promptLabel`, `negativeLabel`, `onChange`, `fabricId` |
| `uploadButton(options)` | File picker button | `label`, `accept`, `multiple`, `onFiles` |
| `dropFile(options)` | Drag-and-drop zone | `label`, `accept`, `onFiles` |

`onChange` receives the new value. Every field also accepts `ariaLabel` and an explicit `id` (a radio group or prompt pair puts the `id` on its group). An option shown as `a` (or `b`) takes either name; if you pass both, `a` wins.

**Every field needs a name a screen reader can read.** Pass `label`: the Builder Kit links it to the control. For a field that shows no label (a lone search box), pass `ariaLabel` instead. A placeholder is not a name, and a save refuses a new field without one. When the user must type or hit an exact value (a bill, a percentage), use `number()`; a `slider()` suits a rough range.

## `fabricId`: agent-settable fields

A `fabricId` names the field for agents and for Batshit's run path. The same IDs go in `metadata.fabric_fields` on the save, and the save refuses a declared field with no matching `fabricId` in the page.

```javascript
const builder = window.batshit.builder;
const controls = document.getElementById('controls');

builder.mount(controls, builder.form.textarea({
  label: 'Positive prompt', placeholder: 'Describe the picture', fabricId: 'positive-prompt',
  onChange: (value) => { state.prompt = value; }
}));
builder.mount(controls, builder.form.select({
  label: 'Image size', options: ['512x512', '1024x1024'], value: '1024x1024', fabricId: 'image-size',
  onChange: (value) => { state.size = value; }
}));
builder.mount(controls, builder.form.number({
  label: 'Steps', min: 1, max: 150, value: 25, fabricId: 'num-steps',
  onChange: (value) => { state.steps = Number(value); }
}));
```

- Clear, unique, stable IDs: `positive-prompt`, `output-format`, not `field1`.
- Supported on `text`, `textarea`, `select`, `multiselect`, `checkbox`, `toggle`, `radio`, `slider`, `number`, `promptPair`. Not on `uploadButton` or `dropFile` (a browser cannot fill a file input for an agent).
- n8n: each `fabricId` must equal the workflow's `$json.body.*` key exactly (`brain-n8n.md`).
- An agent's run of a published artifact happens on the server with the values it sends; it does not fill the fields of a panel the user has open.
- `window.batshit.getFabricFields()` returns the registered fields: `[{ fabricId, type, label, required, options, min, max }]`.

What agents send per field type:

| Primitive | Agent value |
|---|---|
| `text`, `textarea` | string |
| `number`, `slider` | number (with `minimum` / `maximum`) |
| `select`, `radio` | string from the options |
| `multiselect` | array of strings from the options |
| `checkbox`, `toggle` | boolean |
| `promptPair` | `{ prompt, negativePrompt }` |

## Output components (`builder.output.*`)

| Component | What it shows | Key options |
|---|---|---|
| `text(content, options)` | Plain text | `className` |
| `markdown(content, options)` | Rendered Markdown | `className` |
| `media(src, options)` | Image, video, or audio | `type`, `alt`, `controls` |
| `table(rows, options)` | Data table from an array of objects | `columns` (or `headers`): the keys to show, in order, which are also the header text; `className` |
| `statusCard(options)` | Status card | `title`, `kind` (or `status`): `'success'`, `'warning'`, `'error'`, or the default `'info'`; `message` |
| `resultCard(result, options)` | Result card | `title`, `content`, `actions` |

`media()` defaults to an image. Set `type: 'video'` or `type: 'audio'` for playback; native playback controls are shown by default, and `controls: false` hides them. `alt` names an image; `controls` does not affect images.

## Actions (`builder.action.*`)

| Method | What it does |
|---|---|
| `standardControls(options)` | The Share to Chat / Save to Clip Vault / Download bar |
| `run(options)` | Runs `window.batshit.complete()` with `options.prompt` (a helper, not a button) |
| `shareToChat(content, options)` | Shares to the chat |
| `saveToClipVault(content, options)` | Saves as a clip without a chat message |
| `download(content, options)` | Downloads text, JSON, a data URL, or a blob |
| `reset(options)` | Resets fields to their defaults |
| `publishStatus()` | Publish readiness and zone compatibility |

### The standard action bar

Every artifact that produces results includes it:

```javascript
builder.mount(document.getElementById('actions'), builder.action.standardControls({
  storageKey: 'lastResult',
  title: 'Image analysis',
  shareOptions: { type: 'result', format: 'markdown' }
}));
```

- It reads the latest result from `window.batshit.storage` under `storageKey`. When the result lives elsewhere, pass `getPayload: () => ({ title, data })` (or `getSharePayload` / `getDownloadPayload`) and `downloadOptions: { filename, mimeType }`.
- Images: return the picture in the share payload's `image` key so Batshit uploads it safely: `getSharePayload: () => ({ title: 'Generated image', image: result.image, data: 'Prompt: ' + prompt })`.
- `onStatus: (message) => ...` receives status text for your own status line.
- Hide a button only when the user asks: `standardControls({ download: false })`.
- Share something useful: the result text, or the image plus its prompt and settings. Give it a real title ("Workflow output"), not "Result".
- Do not build your own share, save, or download buttons, and do not auto-share.
