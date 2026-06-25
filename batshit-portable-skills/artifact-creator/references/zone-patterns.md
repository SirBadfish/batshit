# Zone-Specific Artifact Patterns

Complete working examples for each artifact zone. Use these as starting scaffolds and customize for the user's needs.

## Universal Rules

Every artifact must:
1. Use `--batshit-*` CSS variables with fallbacks (e.g., `var(--batshit-bg, oklch(0.11 0.02 276))`)
2. Set `* { box-sizing: border-box; margin: 0; padding: 0; }` as reset
3. Use `var(--batshit-font, "Geist Sans", system-ui, sans-serif)` for body font
4. Set body background to `var(--batshit-bg, oklch(0.11 0.02 276))` and color to `var(--batshit-text, oklch(0.87 0.008 289.95))`
5. Do not put the artifact title/name at the top of the body. Batshit already renders that in the artifact chrome. Use section labels only when they organize controls or results.

## Panel Zone (Rich)

Best for: dashboards, multi-section tools, data-heavy applications

**Design principles:**
- Multi-column grids (`grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))`)
- Body padding: 18-24px
- Font size: 14-16px
- Generous spacing (16-24px gaps)
- Room for cards, charts, split layouts
- Max-width: 800-1200px with `margin: 0 auto`
- Responsive breakpoints for narrower views

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Panel Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--batshit-font, "Geist Sans", system-ui, sans-serif);
      background: var(--batshit-bg, #0a0a0a);
      color: var(--batshit-text, #e5e5e5);
      padding: 20px;
      min-height: 100vh;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .header-status {
      color: var(--batshit-muted, oklch(0.49 0.014 289.95));
      font-size: 12px;
      text-transform: uppercase;
    }
    .header-actions button {
      padding: 8px 14px;
      border-radius: var(--batshit-radius, 8px);
      font-size: 13px;
      cursor: pointer;
      border: 1px solid var(--batshit-border, #333);
      background: var(--batshit-surface, #161616);
      color: var(--batshit-text, #e5e5e5);
      margin-left: 8px;
    }
    .header-actions button:hover { background: var(--batshit-surface-elevated, #1a1a1a); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--batshit-surface, #161616);
      border: 1px solid var(--batshit-border, #333);
      border-radius: var(--batshit-radius-lg, 12px);
      padding: 16px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-success { background: var(--batshit-success, #22c55e); color: white; }
    .badge-info { background: var(--batshit-info, #3b82f6); color: white; }
    .badge-warning { background: var(--batshit-warning, #eab308); color: black; }
    .stat-value { font-size: 2rem; font-weight: 600; margin: 8px 0 4px; }
    .stat-label { font-size: 12px; color: var(--batshit-muted, #7a7a7a); }
    .wide-card { grid-column: 1 / -1; }
    .output-area {
      background: var(--batshit-bg, #0a0a0a);
      border-radius: var(--batshit-radius, 8px);
      padding: 14px;
      min-height: 100px;
      white-space: pre-wrap;
      font-size: 14px;
      line-height: 1.6;
    }
    .btn-primary {
      background: var(--batshit-accent, oklch(0.5 0.044 281));
      color: var(--batshit-accent-foreground, oklch(0.96 0.006 289.95));
      border: none;
      padding: 8px 14px;
      border-radius: var(--batshit-radius, 8px);
      cursor: pointer;
      font-size: 13px;
    }
    .btn-primary:hover { background: var(--batshit-accent-hover, oklch(0.56 0.05 281.84)); }
    .btn-primary:disabled { background: var(--batshit-muted, #7a7a7a); cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-status">Live overview</div>
    <div class="header-actions">
      <button onclick="refresh()">Refresh</button>
      <div id="actions"></div>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <span class="badge badge-success">Active</span>
      <div class="stat-value" id="stat1">--</div>
      <div class="stat-label">Total Items</div>
    </div>
    <div class="card">
      <span class="badge badge-info">Processing</span>
      <div class="stat-value" id="stat2">--</div>
      <div class="stat-label">In Progress</div>
    </div>
    <div class="card">
      <span class="badge badge-warning">Pending</span>
      <div class="stat-value" id="stat3">--</div>
      <div class="stat-label">Pending Review</div>
    </div>
    <div class="card wide-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span class="badge badge-info">AI Insights</span>
        <button class="btn-primary" id="insightsBtn" onclick="getInsights()">Generate</button>
      </div>
      <div id="insights" class="output-area">Click Generate to analyze data</div>
    </div>
  </div>
  <script>
    function refresh() {
      document.getElementById('stat1').textContent = Math.floor(Math.random() * 1000);
      document.getElementById('stat2').textContent = Math.floor(Math.random() * 100);
      document.getElementById('stat3').textContent = Math.floor(Math.random() * 50);
    }
    async function getInsights() {
      const el = document.getElementById('insights');
      const btn = document.getElementById('insightsBtn');
      btn.disabled = true;
      el.textContent = '';
      const stats = {
        total: document.getElementById('stat1').textContent,
        inProgress: document.getElementById('stat2').textContent,
        pending: document.getElementById('stat3').textContent
      };
      try {
        await window.batshit.complete('Analyze this data and provide insights', {
          context: stats,
          onChunk: (c) => { el.textContent += c; },
          onEnd: () => { btn.disabled = false; window.batshit.storage.set('lastInsights', el.textContent); }
        });
      } catch (err) { el.textContent = 'Error: ' + (err?.message || err); btn.disabled = false; }
    }
    const actions = window.batshit.builder.action.standardControls({
      storageKey: 'lastInsights',
      title: 'Dashboard Insights',
      shareOptions: { type: 'data', format: 'markdown', initiator: 'user' }
    });
    window.batshit.builder.mount(document.getElementById('actions'), actions);
    refresh();
  </script>
</body>
</html>
```

## Header Zone (Focused)

Best for: image tools, focused utilities, overlay-style tools

**Design principles:**
- Card-based, self-contained layout
- Two-column split (input | output) works well
- Medium density, not as spacious as panel
- Body padding: 18px
- Font size: 14px
- Responsive: collapse to single column on narrow views

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Header Tool</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--batshit-font, "Geist Sans", system-ui, sans-serif);
      background: var(--batshit-bg, #0a0a0a);
      color: var(--batshit-text, #e5e5e5);
      padding: 18px;
      min-height: 100vh;
    }
    .layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      max-width: 800px;
      margin: 0 auto;
    }
    @media (max-width: 640px) { .layout { grid-template-columns: 1fr; } }
    .panel {
      background: var(--batshit-surface, #161616);
      border: 1px solid var(--batshit-border, #333);
      border-radius: var(--batshit-radius-lg, 12px);
      padding: 16px;
    }
    .panel-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--batshit-text-secondary, #a3a3a3);
      margin-bottom: 12px;
    }
    textarea {
      width: 100%;
      min-height: 80px;
      background: var(--batshit-bg, #0a0a0a);
      border: 1px solid var(--batshit-border, #333);
      border-radius: var(--batshit-radius, 8px);
      padding: 12px;
      color: var(--batshit-text, #e5e5e5);
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
    }
    textarea:focus { outline: none; border-color: var(--batshit-accent, oklch(0.5 0.044 281)); }
    .btn-row { display: flex; gap: 8px; margin-top: 12px; }
    button {
      padding: 10px 16px;
      border-radius: var(--batshit-radius, 8px);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }
    .btn-primary {
      background: var(--batshit-accent, oklch(0.5 0.044 281));
      color: var(--batshit-accent-foreground, oklch(0.96 0.006 289.95));
    }
    .btn-primary:hover { background: var(--batshit-accent-hover, oklch(0.56 0.05 281.84)); }
    .btn-primary:disabled { background: var(--batshit-muted, #7a7a7a); cursor: not-allowed; }
    .btn-secondary {
      background: var(--batshit-surface, #161616);
      color: var(--batshit-text, #e5e5e5);
      border: 1px solid var(--batshit-border, #333);
    }
    .btn-secondary:hover { background: var(--batshit-surface-elevated, #1a1a1a); }
    .result-area {
      background: var(--batshit-bg, #0a0a0a);
      border-radius: var(--batshit-radius, 8px);
      min-height: 200px;
      padding: 14px;
      white-space: pre-wrap;
      font-size: 14px;
      line-height: 1.6;
      color: var(--batshit-muted, #7a7a7a);
    }
    .status { font-size: 12px; color: var(--batshit-muted, #7a7a7a); margin-top: 8px; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="panel">
      <div class="panel-title">Input</div>
      <textarea id="prompt" placeholder="Describe what you want..."></textarea>
      <div class="btn-row">
        <button class="btn-primary" id="runBtn" onclick="run()">Generate</button>
        <button class="btn-secondary" onclick="clear()">Clear</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Output</div>
      <div id="result" class="result-area">Results appear here</div>
      <div class="btn-row" id="actions"></div>
      <div id="status" class="status"></div>
    </div>
  </div>
  <script>
    async function run() {
      const prompt = document.getElementById('prompt').value.trim();
      if (!prompt) return;
      const result = document.getElementById('result');
      const btn = document.getElementById('runBtn');
      btn.disabled = true;
      result.textContent = '';
      try {
        const res = await window.batshit.complete(prompt, {
          onChunk: (c) => { result.textContent += c; },
          onEnd: () => { btn.disabled = false; }
        });
        window.batshit.storage.set('lastResult', res.text);
      } catch (err) {
        result.textContent = 'Error: ' + (err?.message || err);
        btn.disabled = false;
      }
    }
    const actions = window.batshit.builder.action.standardControls({
      storageKey: 'lastResult',
      title: 'Result',
      shareOptions: { type: 'data', format: 'markdown', initiator: 'user' },
      onStatus: (message) => { document.getElementById('status').textContent = message; }
    });
    window.batshit.builder.mount(document.getElementById('actions'), actions);
    function clear() {
      document.getElementById('prompt').value = '';
      document.getElementById('result').textContent = 'Results appear here';
    }
  </script>
</body>
</html>
```

## Trigger Zone (Compact Dropdown)

Best for: one-click workflow triggers, quick-action buttons, simple form submissions

**Design principles:**
- Very compact: centered card, small footprint
- Body uses flexbox centering
- One form, one button, one compact result
- Max-width: 400px
- Font size: 13-14px
- Result area is hidden until populated

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Quick Action</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--batshit-font, "Geist Sans", system-ui, sans-serif);
      background: var(--batshit-bg, #0a0a0a);
      color: var(--batshit-text, #e5e5e5);
      padding: 18px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: var(--batshit-surface, #161616);
      border: 1px solid var(--batshit-border, #333);
      border-radius: var(--batshit-radius-lg, 12px);
      padding: 20px;
      width: 100%;
      max-width: 400px;
    }
    .form-group { margin-bottom: 12px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 5px;
      color: var(--batshit-text-secondary, #a3a3a3);
    }
    input, select {
      width: 100%;
      padding: 9px 12px;
      background: var(--batshit-bg, #0a0a0a);
      border: 1px solid var(--batshit-border, #333);
      border-radius: var(--batshit-radius, 8px);
      color: var(--batshit-text, #e5e5e5);
      font-size: 14px;
    }
    input:focus, select:focus { outline: none; border-color: var(--batshit-accent, oklch(0.5 0.044 281)); }
    .btn-trigger {
      width: 100%;
      padding: 12px;
      background: var(--batshit-accent, oklch(0.5 0.044 281));
      color: var(--batshit-accent-foreground, oklch(0.96 0.006 289.95));
      border: none;
      border-radius: var(--batshit-radius, 8px);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 6px;
    }
    .btn-trigger:hover { background: var(--batshit-accent-hover, oklch(0.56 0.05 281.84)); }
    .btn-trigger:disabled { background: var(--batshit-muted, #7a7a7a); cursor: not-allowed; }
    .result {
      margin-top: 14px;
      padding: 10px;
      background: var(--batshit-bg, #0a0a0a);
      border-radius: var(--batshit-radius, 8px);
      font-size: 13px;
      display: none;
      white-space: pre-wrap;
    }
    .result.show { display: block; }
    .result.success { border-left: 3px solid var(--batshit-success, #22c55e); }
    .result.error { border-left: 3px solid var(--batshit-danger, #ef4444); }
  </style>
</head>
<body>
  <div class="card">
    <div class="form-group">
      <label for="input1">Input</label>
      <input type="text" id="input1" placeholder="Enter value..." />
    </div>
    <button class="btn-trigger" id="triggerBtn" onclick="trigger()">Run</button>
    <div id="result" class="result"></div>
  </div>
  <script>
    async function trigger() {
      const btn = document.getElementById('triggerBtn');
      const result = document.getElementById('result');
      const input = document.getElementById('input1').value;
      btn.disabled = true;
      btn.textContent = 'Running...';
      result.className = 'result';
      try {
        const response = await window.batshit.complete('Process this input', {
          context: { input },
          onChunk: (c) => { result.textContent += c; result.classList.add('show', 'success'); }
        });
        result.classList.add('show', 'success');
        if (!result.textContent) result.textContent = response.text;
      } catch (err) {
        result.classList.add('show', 'error');
        result.textContent = 'Error: ' + (err?.message || err);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run';
      }
    }
  </script>
</body>
</html>
```

## CSS Pattern Library

Reusable CSS patterns for common artifact UI elements:

### Cards
```css
.card {
  background: var(--batshit-surface, #161616);
  border: 1px solid var(--batshit-border, #333);
  border-radius: var(--batshit-radius-lg, 12px);
  padding: 16px;
}
```

### Inputs
```css
input, textarea, select {
  width: 100%;
  padding: 10px 12px;
  background: var(--batshit-bg, #0a0a0a);
  color: var(--batshit-text, #e5e5e5);
  border: 1px solid var(--batshit-border, #333);
  border-radius: var(--batshit-radius, 8px);
  font-family: inherit;
  font-size: 14px;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--batshit-accent, oklch(0.5 0.044 281));
}
```

### Primary Button
```css
.btn-primary {
  background: var(--batshit-accent, oklch(0.5 0.044 281));
  color: var(--batshit-accent-foreground, oklch(0.96 0.006 289.95));
  border: none;
  padding: 10px 16px;
  border-radius: var(--batshit-radius, 8px);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}
.btn-primary:hover { background: var(--batshit-accent-hover, oklch(0.56 0.05 281.84)); }
.btn-primary:disabled { background: var(--batshit-muted, #7a7a7a); cursor: not-allowed; }
```

### Secondary Button
```css
.btn-secondary {
  background: var(--batshit-surface, #161616);
  color: var(--batshit-text, #e5e5e5);
  border: 1px solid var(--batshit-border, #333);
  padding: 10px 16px;
  border-radius: var(--batshit-radius, 8px);
  cursor: pointer;
  font-size: 14px;
}
.btn-secondary:hover { background: var(--batshit-surface-elevated, #1a1a1a); }
```

### Status Badges
```css
.badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.badge-success { background: var(--batshit-success, #22c55e); color: white; }
.badge-info { background: var(--batshit-info, #3b82f6); color: white; }
.badge-warning { background: var(--batshit-warning, #eab308); color: black; }
.badge-danger { background: var(--batshit-danger, #ef4444); color: white; }
```

### Loading/Streaming State
```css
.streaming { color: var(--batshit-muted, #7a7a7a); }
```

### Result Area with Status Border
```css
.result { border-left: 3px solid transparent; padding: 12px; }
.result.success { border-left-color: var(--batshit-success, #22c55e); }
.result.error { border-left-color: var(--batshit-danger, #ef4444); }
```
