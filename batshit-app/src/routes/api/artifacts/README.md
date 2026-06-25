# Batshit Artifact Interactive API Documentation

## Overview

The `window.batshit` API enables artifacts to communicate with AI, persist data, and create truly interactive experiences. Every artifact served through Batshit automatically has access to this powerful API.

## Quick Start

```javascript
// Basic AI completion
const response = await window.batshit.complete('Help me understand this code');
console.log(response.text);

// Save data persistently
window.batshit.storage.set('userPrefs', { theme: 'dark' });

// Retrieve saved data
const prefs = window.batshit.storage.get('userPrefs');
```

## API Reference

### Core AI Methods

#### `window.batshit.complete(prompt, options)`
Main AI completion method for general requests.

```javascript
const response = await window.batshit.complete(
  'Generate a summary of these tasks',
  {
    context: { tasks: ['Task 1', 'Task 2'] },
    mode: 'complete' // default
  }
);
```

#### `window.batshit.enhance(prompt, context)`
Request AI to enhance or improve existing content.

```javascript
const enhanced = await window.batshit.enhance(
  'Make this code more efficient',
  { code: myCode }
);
```

#### `window.batshit.fix(prompt, context)`
Ask AI to fix issues or debug problems.

```javascript
const fix = await window.batshit.fix(
  'This function throws an error',
  { error: errorMessage, code: buggyCode }
);
```

#### `window.batshit.explain(prompt, context)`
Get AI explanations of complex topics or code.

```javascript
const explanation = await window.batshit.explain(
  'How does this algorithm work?',
  { algorithm: complexCode }
);
```

### Storage API

Persistent storage that survives across sessions.

#### `window.batshit.storage.set(key, value)`
Save data persistently.

```javascript
window.batshit.storage.set('todos', [
  { text: 'Buy milk', done: false }
]);
```

#### `window.batshit.storage.get(key)`
Retrieve saved data.

```javascript
const todos = window.batshit.storage.get('todos') || [];
```

#### `window.batshit.storage.remove(key)`
Remove a specific key.

```javascript
window.batshit.storage.remove('tempData');
```

#### `window.batshit.storage.clear()`
Clear all storage for this artifact.

```javascript
window.batshit.storage.clear();
```

### Event System

For complex artifact communication patterns.

#### `window.batshit.events.on(event, callback)`
Listen for events.

```javascript
window.batshit.events.on('dataUpdate', (data) => {
  console.log('Data updated:', data);
});
```

#### `window.batshit.events.emit(event, data)`
Emit events.

```javascript
window.batshit.events.emit('dataUpdate', { 
  timestamp: Date.now() 
});
```

#### `window.batshit.events.off(event, callback)`
Remove event listener.

```javascript
window.batshit.events.off('dataUpdate', myHandler);
```

### Metadata

#### `window.batshit.getMetadata()`
Get artifact metadata.

```javascript
const meta = window.batshit.getMetadata();
// { id: 'art_123', type: 'artifact', version: '1.0' }
```

#### `window.batshit.artifactId`
Direct access to artifact ID.

```javascript
console.log('Running artifact:', window.batshit.artifactId);
```

## Response Format

AI responses follow this structure:

```javascript
{
  text: "Main response text",
  suggestions: ["Suggestion 1", "Suggestion 2"],
  code: "// Generated code if applicable",
  improvements: ["Improvement 1", "Improvement 2"],
  solution: "Problem solution",
  explanation: "Detailed explanation",
  status: "completed"
}
```

## Rate Limiting

- **10 requests per minute** per artifact
- **5000 tokens max** per request
- Rate limit info returned in response

```javascript
try {
  const response = await window.batshit.complete('...');
  console.log('Requests remaining:', response.usage.requestsRemaining);
} catch (error) {
  if (error.message.includes('Rate limit')) {
    // Wait and retry
  }
}
```

## Security

- Artifacts run in sandboxed iframes
- API calls require valid session authentication
- Cross-origin requests are blocked
- Storage is isolated per artifact

## Example: Interactive Todo App

```javascript
// AI-powered task suggestions
async function suggestTasks() {
  const response = await window.batshit.complete(
    'Suggest 3 tasks based on my current todos',
    { 
      context: { 
        todos: getCurrentTodos() 
      } 
    }
  );
  
  if (response.suggestions) {
    response.suggestions.forEach(task => {
      addTodo(task);
    });
  }
}

// Persistent storage
function saveTodos() {
  window.batshit.storage.set('todos', todos);
}

function loadTodos() {
  return window.batshit.storage.get('todos') || [];
}

// On load
window.addEventListener('load', () => {
  if (window.batshit && window.batshit.ready) {
    const saved = loadTodos();
    renderTodos(saved);
  }
});
```

## Best Practices

1. **Always check for API availability**
   ```javascript
   if (window.batshit && window.batshit.complete) {
     // API is available
   }
   ```

2. **Handle errors gracefully**
   ```javascript
   try {
     const response = await window.batshit.complete('...');
   } catch (error) {
     showUserFriendlyError(error.message);
   }
   ```

3. **Provide context for better AI responses**
   ```javascript
   const response = await window.batshit.complete(prompt, {
     context: {
       currentState: getAppState(),
       userPreferences: getUserPrefs()
     }
   });
   ```

4. **Use appropriate modes**
   - `complete` - General requests
   - `enhance` - Improvements
   - `fix` - Debugging
   - `explain` - Understanding

5. **Respect rate limits**
   - Cache responses when possible
   - Batch related requests
   - Show loading states during API calls

## Future Enhancements

Coming soon:
- Real-time collaboration features
- Webhook triggers from artifacts
- Cross-artifact communication
- Advanced AI models selection
- Streaming responses
- File upload/download capabilities