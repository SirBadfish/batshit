# Zone Layout Patterns

**Load when:** a custom visual layout (a dashboard grid, a two-column input and output view, a compact trigger card) needs a zone-sized scaffold. **Not for Builder Kit forms:** a form tool (fields, a run button, a result) needs only `brain-general.md` and `builder-kit-api.md`. These scaffolds are page shells; the fields inside them still come from Builder Kit.

## Rules for every zone

1. Theme variables with fallbacks (`var(--batshit-bg, oklch(0.1656 0.0127 277.51))`), never fixed colours; the token list is in `brain-general.md`.
2. `* { box-sizing: border-box; }`, body font `var(--batshit-font, system-ui, sans-serif)`.
3. No artifact title at the top: Batshit draws it. Section labels ("Input", "Result") are fine.
4. Fields from Builder Kit with labels and `fabricId`s; results get `standardControls()`.
5. Buttons have hover and disabled states; async work shows a status.

| Zone | Shape | Padding and type | Width |
|---|---|---|---|
| panel | Multi-column grid, cards, split views | 18-24px padding, 14-16px text, 16-24px gaps | 800-1200px, centred |
| header | Self-contained card; input and output side by side | 18px padding, 14px text | up to 800px; one column below 640px |
| trigger | One small card: fields, one button, a compact result | 18px padding, 13-14px text | up to 400px, centred |

## Panel: dashboard grid

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; font-family: var(--batshit-font, system-ui, sans-serif);
      background: var(--batshit-bg, oklch(0.1656 0.0127 277.51)); color: var(--batshit-text, oklch(0.87 0.008 289.95)); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; max-width: 1100px; margin: 0 auto; }
    .card { background: var(--batshit-surface, oklch(0.16 0.02 276)); border: 1px solid var(--batshit-border-subtle, #2a2a33);
      border-radius: var(--batshit-radius-lg, 12px); padding: 16px; }
    .wide { grid-column: 1 / -1; display: grid; gap: 12px; }
    .stat { font-size: 2rem; font-weight: 600; margin: 6px 0 2px; }
    .label { font-size: 12px; color: var(--batshit-muted, oklch(0.49 0.014 289.95)); }
    .output { min-height: 100px; white-space: pre-wrap; line-height: 1.6; padding: 12px;
      border-radius: var(--batshit-radius, 8px); background: var(--batshit-surface-inset, oklch(0.13 0.02 276)); }
  </style>
</head>
<body>
  <div class="grid">
    <div class="card"><div class="label">Total items</div><div class="stat" id="total">--</div></div>
    <div class="card"><div class="label">In progress</div><div class="stat" id="active">--</div></div>
    <div class="card"><div class="label">Pending review</div><div class="stat" id="pending">--</div></div>
    <div class="card wide" id="insights">
      <div id="insight-controls"></div>
      <div class="output" id="insight-output">Pick a focus and run the analysis.</div>
      <div id="insight-actions"></div>
    </div>
  </div>
  <script>
    const builder = window.batshit.builder;
    const state = { focus: 'Trends' };
    builder.mount(document.getElementById('insight-controls'), builder.form.select({
      label: 'Focus', options: ['Trends', 'Risks', 'Next steps'], value: state.focus, fabricId: 'focus',
      onChange: (value) => { state.focus = value; }
    }));
    builder.mount(document.getElementById('insight-actions'), builder.action.standardControls({
      storageKey: 'lastInsights', title: 'Dashboard insights',
      shareOptions: { type: 'data', format: 'markdown' }
    }));
    // Fill #total, #active, #pending from your data source, and run
    // window.batshit.complete() into #insight-output from a button you add.
  </script>
</body>
</html>
```

## Header: input and output side by side

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; font-family: var(--batshit-font, system-ui, sans-serif);
      background: var(--batshit-bg, oklch(0.1656 0.0127 277.51)); color: var(--batshit-text, oklch(0.87 0.008 289.95)); }
    .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 800px; margin: 0 auto; }
    @media (max-width: 640px) { .layout { grid-template-columns: 1fr; } }
    .pane { display: grid; gap: 12px; align-content: start; padding: 16px; border-radius: var(--batshit-radius-lg, 12px);
      background: var(--batshit-surface, oklch(0.16 0.02 276)); border: 1px solid var(--batshit-border-subtle, #2a2a33); }
    .section { font-size: 13px; font-weight: 500; color: var(--batshit-text-secondary, oklch(0.7 0.01 289.95)); }
    .result { min-height: 200px; white-space: pre-wrap; line-height: 1.6; font-size: 14px; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="pane" id="input"><div class="section">Input</div></div>
    <div class="pane">
      <div class="section">Result</div>
      <div class="result" id="result"></div>
      <div id="actions"></div>
    </div>
  </div>
  <script>
    const builder = window.batshit.builder;
    const state = { request: '' };
    builder.mount(document.getElementById('input'), builder.form.textarea({ label: 'Describe what you want', rows: 5,
      fabricId: 'request', onChange: (value) => { state.request = value; } }));
    // Add a run button to #input that streams window.batshit.complete() into #result
    // and stores the text under 'lastResult'.
    builder.mount(document.getElementById('actions'), builder.action.standardControls({
      storageKey: 'lastResult', title: 'Result', shareOptions: { type: 'result', format: 'markdown' }
    }));
  </script>
</body>
</html>
```

## Trigger: compact card

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: var(--batshit-font, system-ui, sans-serif); font-size: 14px;
      background: var(--batshit-bg, oklch(0.1656 0.0127 277.51)); color: var(--batshit-text, oklch(0.87 0.008 289.95)); }
    .card { width: 100%; max-width: 400px; display: grid; gap: 12px; padding: 20px; border-radius: var(--batshit-radius-lg, 12px);
      background: var(--batshit-surface, oklch(0.16 0.02 276)); border: 1px solid var(--batshit-border-subtle, #2a2a33); }
    .go { padding: 12px; border: 0; border-radius: var(--batshit-radius, 8px); font-weight: 600; cursor: pointer;
      background: var(--batshit-primary, oklch(0.33 0.07 274.7)); color: var(--batshit-primary-foreground, oklch(0.96 0.006 289.95)); }
    .go:disabled { opacity: 0.6; cursor: default; }
    .result { display: none; padding: 10px; white-space: pre-wrap; border-radius: var(--batshit-radius, 8px);
      border-left: 3px solid var(--batshit-success, #22c55e); background: var(--batshit-surface-inset, oklch(0.13 0.02 276)); }
    .result.show { display: block; }
    .result.error { border-left-color: var(--batshit-danger, #ef4444); }
  </style>
</head>
<body>
  <div class="card" id="card">
    <button class="go" id="go">Run</button>
    <div class="result" id="result"></div>
  </div>
  <script>
    const builder = window.batshit.builder;
    const card = document.getElementById('card');
    const state = { target: '' };
    card.prepend(builder.form.text({ label: 'Target', fabricId: 'target', onChange: (value) => { state.target = value; } }));
    document.getElementById('go').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const result = document.getElementById('result');
      button.disabled = true;
      result.className = 'result';
      try {
        const reply = await window.batshit.complete('Run the action for this target.', { context: { target: state.target } });
        result.textContent = reply.text;
        result.classList.add('show');
      } catch (error) {
        result.textContent = 'Error: ' + (error && error.message ? error.message : error);
        result.classList.add('show', 'error');
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>
```

A trigger with no fields at all drops the text field and sets `metadata.run_only: true`.
