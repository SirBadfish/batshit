# Native Artifact Build Guide

**Load when:** you are building a native artifact: a static tool, a Built-in AI tool, or the UI for an n8n or custom webhook. It has the build steps, a working page skeleton, the action bar, and the theme. AI calls are in `ai-capabilities.md`, model choice in `ai-models.md`, and every Builder Kit option in `builder-kit-api.md`.

## Build steps

1. **Research only what you do not know.** If the request depends on an API, product, or model you are unsure of, or one that changes quickly, search the web first (`native_web_search`, or your lane's web search). Skip it for everyday tools such as calculators and text helpers.
2. **Plan** with the SKILL.md checklist: zone, fields, one Builder Kit primitive per field, `fabricId`s, power source, and (Built-in AI) the exact model.
3. **Write the page** from the skeleton below.
4. **Save once.** One `sys.artifact.create` carries everything: `name`, `content`, `metadata` (`source_type` plus `fabric_fields` or `run_only`), `brain_type`, `zone`, `icon_ref`, and for Built-in AI `model_config` and `system_prompt`. Add `mode: "published"` when it is ready to use; that publishes it in the same call. If the save is refused, fix each listed problem and send it again.
5. **Built-in AI or webhook: run it once** through its `artifact:use.artifact.{slug}` ref (search `family: "artifact"` for its name), unless the user asked you not to (a portable agent without that lane asks the user to run it in Batshit). Load `fabric-and-agent-use.md` if the run fails. An image generator is done only when the run log shows `result.fileCount` above 0. A static tool has no agent run: it works in its panel.
6. **Tell the user** what you built, where it is (zone), and anything they must still do, such as saving an API key.

Create a new artifact for each build request. Change an existing one only when the user names it; `editing.md` covers that.

## Page skeleton

Write a whole document with a `<head>`. Batshit injects its runtime at the end of `<head>`, so scripts in `<body>` can use `window.batshit` at once. (With no `</head>`, the runtime lands at the end of `<body>`, after your script; then wrap your code in a `DOMContentLoaded` listener.)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; font-family: var(--batshit-font, system-ui, sans-serif);
      background: var(--batshit-bg, oklch(0.1656 0.0127 277.51)); color: var(--batshit-text, oklch(0.87 0.008 289.95)); }
    #app { display: grid; gap: 12px; max-width: 720px; }
    .result { min-height: 60px; padding: 12px; white-space: pre-wrap; border-radius: var(--batshit-radius, 8px);
      background: var(--batshit-surface, oklch(0.16 0.02 276)); border: 1px solid var(--batshit-border-subtle, #2a2a33); }
    .run { justify-self: start; padding: 8px 16px; border: 0; border-radius: var(--batshit-radius, 8px); cursor: pointer;
      background: var(--batshit-primary, oklch(0.33 0.07 274.7)); color: var(--batshit-primary-foreground, oklch(0.96 0.006 289.95)); }
    .run:disabled { opacity: 0.6; cursor: default; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const builder = window.batshit.builder;
    const app = document.getElementById('app');
    const state = { text: '', tone: 'Friendly' };

    builder.mount(app, builder.form.textarea({ label: 'Text', rows: 5, fabricId: 'text',
      onChange: (value) => { state.text = value; } }));
    builder.mount(app, builder.form.select({ label: 'Tone', options: ['Friendly', 'Formal'], value: state.tone,
      fabricId: 'tone', onChange: (value) => { state.tone = value; } }));

    const button = document.createElement('button');
    button.className = 'run';
    button.textContent = 'Rewrite';
    const result = document.createElement('div');
    result.className = 'result';
    app.append(button, result);

    button.addEventListener('click', async () => {
      if (!state.text.trim()) { result.textContent = 'Add some text first.'; return; }
      button.disabled = true;
      result.textContent = '';
      try {
        const reply = await window.batshit.complete('Rewrite the text in the requested tone.', {
          context: { text: state.text, tone: state.tone },
          onChunk: (chunk) => { result.textContent += chunk; }
        });
        window.batshit.storage.set('lastResult', reply.text);
      } catch (error) {
        result.textContent = 'Error: ' + (error && error.message ? error.message : error);
      } finally {
        button.disabled = false;
      }
    });

    builder.mount(app, builder.action.standardControls({ storageKey: 'lastResult', title: 'Rewritten text',
      shareOptions: { type: 'result', format: 'markdown' } }));
  </script>
</body>
</html>
```

Its save payload declares the same fields: `metadata: { source_type: "built_in", fabric_fields: [{ fabricId: "text", type: "textarea", label: "Text" }, { fabricId: "tone", type: "select", label: "Tone", options: ["Friendly", "Formal"] }] }`, with `brain_type: "built_in"`, `model_config`, and a `system_prompt` such as "Rewrite the user's text in the requested tone." A static tool drops the AI call, computes the result in `onChange`, sets `brain_type: "none"` and `source_type: "static"`, and needs no model.

Skeleton rules:

- Alias the kit as `const builder = window.batshit.builder` (the save check recognises `builder` and the full `window.batshit.builder.` path, not other names).
- A plain `<button>` is fine for the run action: its text is its name. Fields come from Builder Kit.
- **Put the standing instructions in `system_prompt`.** Every run uses it. An agent's run sends only the field values (and an optional prompt), not your page's prompt text, so an artifact whose instructions live only in its script gives agents a generic answer.
- Read values from `onChange` or `component.input.value`; do not guess at return shapes.
- The skeleton's AI call is `window.batshit.complete()`. Load `ai-capabilities.md` for images, speech, or structured output.

## Action bar (results)

An artifact that produces results renders `builder.action.standardControls()`: **Share to Chat**, **Save to Clip Vault**, **Download**. Do not build your own share, save, or download buttons, do not auto-share, and do not hide, relabel, or reorder them unless the user asks. Store the latest result under the `storageKey`, or pass `getPayload` / `getSharePayload`. An image result goes in the share payload's `image` key (`builder-kit-api.md`).

## Theme

Batshit injects its theme variables into every artifact. Use them, each with a fallback, instead of fixed colours: `var(--batshit-bg, oklch(0.1656 0.0127 277.51))`.

- **Surfaces:** `--batshit-bg`, `--batshit-surface`, `--batshit-surface-elevated`, `--batshit-surface-inset`
- **Text:** `--batshit-text`, `--batshit-text-strong`, `--batshit-text-secondary`, `--batshit-muted`, `--batshit-faint`
- **Primary:** `--batshit-primary`, `--batshit-primary-foreground`, `--batshit-primary-hover`, `--batshit-primary-text`, `--batshit-primary-soft`, `--batshit-primary-faint`, `--batshit-ring`
- **Status:** `--batshit-success`, `--batshit-danger`, `--batshit-warning`, `--batshit-info`
- **Lines and fields:** `--batshit-border`, `--batshit-border-strong`, `--batshit-border-subtle`, `--batshit-field`, `--batshit-field-hover`, `--batshit-field-border`, `--batshit-field-border-hover`
- **Shape and type:** `--batshit-radius-sm` (4px), `--batshit-radius` (8px), `--batshit-radius-lg` (12px), `--batshit-font`, `--batshit-font-mono`

The primary comes in two parts, like the app. `--batshit-primary` is a dark **fill**: use it only behind light `--batshit-primary-foreground` text (a primary button, a selected chip). `--batshit-primary-text` is the **mark**: text, icons, borders, slider fills, and spinners drawn on the page; the fill drawn on the page nearly vanishes. `--batshit-primary-soft` / `-faint` are washes for hover and selection; `--batshit-ring` is the focus ring. The older `--batshit-accent*` names now carry the mark; use the primary names in new work. Surfaces for cards, field tokens for inputs, status colours for status only.

## Script pitfalls

- Never put dynamic strings inside `onclick="..."` attributes; the quotes break. Create the element and use `addEventListener` with `dataset` values.
- Never write a literal `</script>` inside a script; write `<\/script>`.
- Write real template literals (`${value}`), not escaped ones. The save refuses an inline script that does not parse.

## Webhook and imports

- An n8n or custom webhook artifact calls its workflow through the same `window.batshit.complete()`; Batshit routes it by the saved power source. Set `webhook_url` on create (or with `sys.artifact.set_webhook`). n8n specifics are in `brain-n8n.md`.
- `sys.artifact.analyze_url` evaluates an outside source (a HuggingFace Space, a GitHub or plain HTML file) before you import it; the size cap is 200 KB.
