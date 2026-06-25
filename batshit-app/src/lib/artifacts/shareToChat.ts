/**
 * Share-to-Chat System for Artifacts
 * 
 * This enables bidirectional communication where artifacts can push
 * data back into the main chat conversation as clips.
 */

export interface ShareToChatData {
  artifactId: string;
  artifactName: string;
  type: 'screenshot' | 'data' | 'selection' | 'export' | 'status';
  content: string | any;
  format?: 'text' | 'json' | 'markdown' | 'image';
  timestamp: string;
}

/**
 * Window API extension for artifacts to share to chat
 * This gets injected into the artifact's window.batshit namespace
 */
export const SHARE_TO_CHAT_API = `
// Share-to-Chat API
window.batshit.shareToChat = async function(content, options = {}) {
  try {
    const shareData = {
      artifactId: window.batshit.artifactId,
      artifactName: window.batshit.artifactName || 'Artifact',
      type: options.type || 'data',
      content: content,
      format: options.format || 'text',
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || window.batshit.sessionId || null,
      includeInChat: options.includeInChat !== false,
      initiator: options.initiator || 'user'
    };
    
    // Send to parent window (Batshit main app)
    // SA-011: Added version header for forward compatibility
    window.parent.postMessage({
      type: 'batshit:artifact:share',
      version: '1.0',
      data: shareData
    }, '*');
    
    // Also send to API endpoint for persistence
    const batshitFetch = window.batshit._fetch || fetch.bind(window);
    const response = await batshitFetch('/api/artifacts/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(shareData)
    });
    
    if (!response.ok) {
      throw new Error('Failed to share to chat');
    }
    
    const result = await response.json();

    if (result && result.clipId && shareData.sessionId) {
      window.parent.postMessage({
        type: 'batshit:session-clip-state-changed',
        version: '1.0',
        artifactId: shareData.artifactId,
        data: {
          sessionId: shareData.sessionId,
          clipId: result.clipId,
          source: 'artifact-share'
        }
      }, '*');
    }
    
    // Show success feedback
    if (window.batshit.showToast) {
      window.batshit.showToast('Shared to chat!', 'success');
    }
    
    return result;
    
  } catch (error) {
    console.error('Share to chat error:', error);
    if (window.batshit.showToast) {
      window.batshit.showToast('Failed to share', 'error');
    }
    throw error;
  }
};

// Save-to-vault helper (persists clip without posting a chat message)
window.batshit.saveToClipVault = async function(content, options = {}) {
  return window.batshit.shareToChat(content, {
    ...options,
    includeInChat: false
  });
};

// Screenshot sharing helper
window.batshit.shareScreenshot = async function(canvasOrElement, title) {
  try {
    let imageData;
    
    if (canvasOrElement instanceof HTMLCanvasElement) {
      // Canvas element - get data URL
      imageData = canvasOrElement.toDataURL('image/png');
    } else if (canvasOrElement instanceof HTMLElement) {
      // HTML element - use html2canvas if available
      if (window.html2canvas) {
        const canvas = await window.html2canvas(canvasOrElement);
        imageData = canvas.toDataURL('image/png');
      } else {
        throw new Error('html2canvas not loaded');
      }
    } else {
      throw new Error('Invalid element type');
    }
    
    return window.batshit.shareToChat({
      title: title || 'Screenshot',
      image: imageData
    }, {
      type: 'screenshot',
      format: 'image'
    });
    
  } catch (error) {
    console.error('Screenshot share error:', error);
    throw error;
  }
};

// Data export helper
window.batshit.shareData = function(data, title, format) {
  const formatted = format === 'json' 
    ? JSON.stringify(data, null, 2)
    : data;
    
  return window.batshit.shareToChat({
    title: title || 'Exported Data',
    data: formatted
  }, {
    type: 'export',
    format: format || 'json'
  });
};

// Selection sharing helper
window.batshit.shareSelection = function(selectedItems, context) {
  return window.batshit.shareToChat({
    selected: selectedItems,
    context: context || {}
  }, {
    type: 'selection',
    format: 'json'
  });
};

// Status sharing helper
window.batshit.shareStatus = function(statusMessage, details) {
  return window.batshit.shareToChat({
    status: statusMessage,
    details: details || {}
  }, {
    type: 'status',
    format: 'markdown'
  });
};

// Toast notification helper (for user feedback)
window.batshit.showToast = function(message, type = 'info') {
  // Create toast element if it doesn't exist
  let toast = document.getElementById('batshit-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'batshit-toast';
    toast.style.cssText = \`
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      color: white;
      font-family: system-ui;
      font-size: 14px;
      z-index: var(--z-toast);
      transition: opacity 0.3s;
      pointer-events: none;
    \`;
    document.body.appendChild(toast);
  }
  
  // Set colors based on type
  const colors = {
    success: '#14b8a6',
    error: '#ef4444',
    info: '#3b82f6',
    warning: '#f59e0b'
  };
  
  toast.style.backgroundColor = colors[type] || colors.info;
  toast.textContent = message;
  toast.style.opacity = '1';
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
  }, 3000);
};
`;

/**
 * Generate Share-to-Chat buttons for common artifact types
 */
export function generateShareButtons(artifactType: string): string {
  const buttonStyles = `
    .share-buttons {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #333;
    }
    
    .share-btn {
      padding: 8px 16px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 6px;
      color: #e5e5e5;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    
    .share-btn:hover {
      background: #333;
      border-color: #f97316;
    }
    
    .share-btn svg {
      width: 16px;
      height: 16px;
    }
  `;

  const buttons: Record<string, string> = {
    todo: `
      <div class="share-buttons">
        <button class="share-btn" onclick="shareTodos()">
          Share Todo List
        </button>
        <button class="share-btn" onclick="shareCompleted()">
          Share Completed
        </button>
        <button class="share-btn" onclick="shareStats()">
          Share Stats
        </button>
      </div>
    `,
    
    spotify: `
      <div class="share-buttons">
        <button class="share-btn" onclick="shareNowPlaying()">
          Share Now Playing
        </button>
        <button class="share-btn" onclick="sharePlaylist()">
          Share Playlist
        </button>
        <button class="share-btn" onclick="shareHistory()">
          Share History
        </button>
      </div>
    `,
    
    database: `
      <div class="share-buttons">
        <button class="share-btn" onclick="shareQuery()">
          Share Query
        </button>
        <button class="share-btn" onclick="shareResults()">
          Export Results
        </button>
        <button class="share-btn" onclick="shareSchema()">
          Share Schema
        </button>
      </div>
    `,
    
    canvas: `
      <div class="share-buttons">
        <button class="share-btn" onclick="shareDrawing()">
          Share Drawing
        </button>
        <button class="share-btn" onclick="shareSelection()">
          Share Selection
        </button>
        <button class="share-btn" onclick="saveToDisk()">
          Save to Disk
        </button>
      </div>
    `,
    
    default: `
      <div class="share-buttons">
        <button class="share-btn" onclick="shareContent()">
          Share to Chat
        </button>
        <button class="share-btn" onclick="exportData()">
          Export Data
        </button>
      </div>
    `
  };

  return `
    <style>${buttonStyles}</style>
    ${buttons[artifactType] || buttons.default}
  `;
}

/**
 * Example share functions for artifacts to implement
 */
export const SHARE_FUNCTION_EXAMPLES = {
  todo: `
// Share todo list to chat
async function shareTodos() {
  const todos = window.todos || []; // Reference to actual todos array
  const todoData = {
    total: todos.length,
    completed: todos.filter(t => t.completed).length,
    pending: todos.filter(t => !t.completed).length,
    items: todos.map(t => ({
      text: t.text,
      completed: t.completed,
      priority: t.priority || 'normal'
    }))
  };
  
  await window.batshit.shareData(todoData, 'Todo List Export', 'json');
}

// Share completed tasks
async function shareCompleted() {
  const todos = window.todos || []; // Reference to actual todos array
  const completed = todos.filter(t => t.completed);
  const message = completed.length > 0
    ? \`Completed tasks (\${completed.length}):\\n\${completed.map(t => '- ' + t.text).join('\\n')}\`
    : 'No completed tasks yet';
    
  await window.batshit.shareToChat(message, { type: 'status', format: 'markdown' });
}
`,

  spotify: `
// Share currently playing track
async function shareNowPlaying() {
  const currentTrack = window.currentTrack || null; // Reference to actual current track
  if (!currentTrack) {
    await window.batshit.shareStatus('Nothing playing');
    return;
  }
  
  const nowPlaying = \`Now Playing: **\${currentTrack.name}** by \${currentTrack.artist} (\${currentTrack.album})\`;
  await window.batshit.shareToChat(nowPlaying, { type: 'status', format: 'markdown' });
}

// Share playlist
async function sharePlaylist() {
  const currentPlaylist = window.currentPlaylist || { name: 'Unknown', tracks: [] };
  const playlistData = {
    name: currentPlaylist.name,
    tracks: currentPlaylist.tracks.map((t, i) => 
      \`\${i + 1}. \${t.name} - \${t.artist}\`
    ).join('\\n')
  };
  
  await window.batshit.shareData(playlistData, 'Spotify Playlist', 'markdown');
}
`,

  canvas: `
// Share canvas drawing as image
async function shareDrawing() {
  const canvas = document.getElementById('drawingCanvas');
  await window.batshit.shareScreenshot(canvas, 'My Drawing');
}

// Share selected area
async function shareSelection() {
  const selection = window.selection || null; // Reference to actual selection
  if (!selection) {
    await window.batshit.shareStatus('No selection');
    return;
  }
  
  // Create temporary canvas for selection
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = selection.width;
  tempCanvas.height = selection.height;
  const ctx = tempCanvas.getContext('2d');
  
  // Copy selection to temp canvas
  const mainCanvas = document.getElementById('drawingCanvas'); // Reference to actual canvas
  ctx.drawImage(mainCanvas, 
    selection.x, selection.y, selection.width, selection.height,
    0, 0, selection.width, selection.height
  );
  
  await window.batshit.shareScreenshot(tempCanvas, 'Selection');
}
`
};
