# Artifact Templates Gallery

Starter templates and the design patterns they demonstrate. Use these as references when building new artifacts.

## Template Index

| Template | Zone | Key Pattern | Best For |
|---|---|---|---|
| Minimal AI Chat | panel | Streaming completion + compact layout | Quick AI tools |
| Form + AI | panel | Settings controls + output card + share | Processing tools |
| Image Tool | header | File upload + split layout + media display | Visual tools |
| Data Dashboard | panel | Stats grid + AI insights + refresh | Monitoring tools |
| Workflow Trigger | trigger | Form inputs + action button + result card | n8n integrations |

## Pattern: Streaming Completion

Used by: Minimal AI Chat, Form + AI, Dashboard

The core pattern for AI-powered artifacts:

```javascript
async function run() {
  const text = document.getElementById('prompt').value.trim();
  if (!text) return;

  const output = document.getElementById('output');
  const btn = document.getElementById('runBtn');

  // Disable UI during generation
  btn.disabled = true;
  output.textContent = '';

  try {
    const result = await window.batshit.complete(text, {
      mode: 'complete',
      onChunk: (chunk) => {
        output.textContent += chunk;
      },
      onEnd: () => {
        btn.disabled = false;
      },
      onError: (err) => {
        output.textContent = 'Error: ' + (err?.message || err);
        btn.disabled = false;
      }
    });

    // Store result for share-to-chat
    window.batshit.storage.set('lastResult', result.text);
  } catch (err) {
    output.textContent = 'Error: ' + (err?.message || err);
    btn.disabled = false;
  }
}
```

**Key principles:**
- Always disable the button during generation to prevent double-sends
- Clear output before starting
- Use `onChunk` for progressive display (feels responsive)
- Use `onError` callback AND try/catch for complete error coverage
- Store results in `window.batshit.storage` for share-to-chat reuse

## Pattern: Context Passing

Used by: Form + AI, Dashboard

Pass structured data to the AI along with the prompt:

```javascript
const result = await window.batshit.complete('Analyze this data', {
  mode: 'complete',
  context: {
    stats: { total: 100, active: 42, pending: 15 },
    filters: { dateRange: 'last7days' },
    tone: 'professional'
  }
});
```

**Key principles:**
- `context` is serialized and included in the AI prompt
- Keep context concise (it counts against token limits)
- Use meaningful keys that help the AI understand the data

## Pattern: Standard Action Controls

Used by: Form + AI, Dashboard, Image Tool

Render the fixed action bar (`Share to Chat`, `Save to Clip Vault`, `Download`):

```javascript
const actions = window.batshit.builder.action.standardControls({
  storageKey: 'lastResult',
  title: 'Tool Result',
  shareOptions: { type: 'data', format: 'markdown', initiator: 'user' },
  onStatus: (message) => showStatus(message)
});
window.batshit.builder.mount(document.getElementById('actions'), actions);
```

**Key principles:**
- Keep controls standardized so artifacts behave consistently
- Keep sharing user-triggered by default (button click)
- Use meaningful titles that identify the source artifact
- Choose format based on content type (`markdown` for text, `json` for data)

## Pattern: File Upload + Preview

Used by: Image Tool

Handle file uploads with drag-and-drop and preview grid:

```javascript
let uploadedFiles = [];

// Drag and drop setup
const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

function handleFiles(files) {
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      uploadedFiles.push({ name: file.name, data: e.target.result });
      renderPreviews();
    };
    reader.readAsDataURL(file);
  });
}
```

**Key principles:**
- Filter by file type (`image/*`, `audio/*`, etc.)
- Use FileReader to convert to data URLs for preview
- Provide visual feedback during drag (CSS class toggle)
- Support both click-to-upload and drag-and-drop

## Pattern: Webhook Transport

Used by: Workflow Trigger

Call n8n or external webhooks instead of built-in AI:

```javascript
const response = await window.batshit.complete(
  'Execute workflow',
  {
    context: formPayload,
    mode: 'complete'
  }
);
```

**Key principles:**
- Check `window.batshit.artifactWebhook` to determine if webhook is configured
- Batshit chooses the completion route from the artifact's saved power source
- `context` becomes part of the webhook payload
- Webhook responses are buffered (no streaming), so show a loading state

## Pattern: Persistent State

Used by: Dashboard (refresh data across uses)

Use artifact localStorage for cross-session persistence:

```javascript
// Save state
window.batshit.storage.set('dashboardData', {
  lastRefresh: new Date().toISOString(),
  stats: currentStats
});

// Restore state on load
const saved = window.batshit.storage.get('dashboardData');
if (saved) {
  restoreStats(saved.stats);
  showLastRefresh(saved.lastRefresh);
}
```

## Pattern: Status Feedback

Used across all templates. Always provide clear status to the user:

```javascript
function showStatus(message, type = '') {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = 'status' + (type ? ' ' + type : '');
}

// Usage
showStatus('Generating...', '');
showStatus('Complete', 'success');
showStatus('Error: ' + err.message, 'error');
```

With CSS:
```css
.status { font-size: 12px; color: var(--batshit-muted, #7a7a7a); margin-top: 8px; }
.status.success { color: var(--batshit-success, #22c55e); }
.status.error { color: var(--batshit-danger, #ef4444); }
```

## Design Quality Checklist

When building any artifact, verify:

- [ ] Uses `--batshit-*` CSS variables with fallbacks (not hardcoded colors)
- [ ] Reset applied: `* { box-sizing: border-box; margin: 0; padding: 0; }`
- [ ] Body uses `var(--batshit-font)`, `var(--batshit-bg)`, `var(--batshit-text)`
- [ ] Buttons have `:hover` and `:disabled` states
- [ ] Inputs have `:focus` states with accent border
- [ ] Loading/streaming states are visually distinct
- [ ] Error states are clearly communicated
- [ ] Layout is appropriate for the target zone
- [ ] Status feedback is provided for all async operations
- [ ] Share-to-chat works when applicable
