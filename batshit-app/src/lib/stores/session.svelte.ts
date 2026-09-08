// Session store using Svelte 5 runes
export interface ChatSession {
  id: string
  user_id?: string
  name?: string  // Changed from title to match database schema
  folder_id?: string  // For organizing sessions
  created_at: string
  last_modified_at: string  // Changed from last_activity to match database schema
  metadata?: Record<string, any>
  archived?: boolean
  archived_at?: string | null
  locked?: boolean
  agent_id?: string  // Added to match ChatSessionRow
}

let sessions = $state<ChatSession[]>([])
let currentSessionId = $state<string | null>(null)

const LAST_SESSION_STORAGE_KEY = 'batshit:lastSessionId'

function setSessionIdWithPersistence(id: string | null) {
  currentSessionId = id
  if (typeof window !== 'undefined') {
    if (id) {
      localStorage.setItem(LAST_SESSION_STORAGE_KEY, id)
    } else {
      localStorage.removeItem(LAST_SESSION_STORAGE_KEY)
    }
  }
}

if (typeof window !== 'undefined') {
  const storedId = localStorage.getItem(LAST_SESSION_STORAGE_KEY)
  if (storedId) {
    currentSessionId = storedId
  }
}

type SessionStateSnapshot = {
  sessions: ChatSession[]
  currentSessionId: string | null
}

const listeners = new Set<(state: SessionStateSnapshot) => void>()

function notifyListeners() {
  const snapshot: SessionStateSnapshot = {
    sessions,
    currentSessionId
  }

  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('[sessionStore] Listener error:', error)
    }
  })
}

// Export reactive getters
export const sessionState = {
  get sessions() {
    return sessions
  },
  get currentSessionId() {
    return currentSessionId
  }
}

export function getSessions() {
  return sessions
}

export function getCurrentSessionId() {
  return currentSessionId
}

export function setSessions(newSessions: ChatSession[]) {
  sessions = newSessions
  notifyListeners()
}

export function setCurrentSessionId(id: string | null) {
  setSessionIdWithPersistence(id)
  notifyListeners()
}

export function setCurrentSession(id: string | null) {
  setCurrentSessionId(id)
}

export function addSession(session: ChatSession) {
  sessions = [...sessions, session]
  notifyListeners()
}

/**
 * SA-113 P1 (DL-113-06) — add or patch a session that arrived on the user channel.
 *
 * `addSession` appends unconditionally, which is safe for the client's own New Chat but
 * not for a push channel: a reconnect can replay, and a session Batshit created may
 * already be in the list from a `loadSessions()` that raced it. Newest-first matches how
 * a new chat sorts in the sidebar.
 */
export function upsertSession(session: ChatSession) {
  const index = sessions.findIndex((s) => s.id === session.id)
  if (index === -1) {
    sessions = [session, ...sessions]
  } else {
    sessions = sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s))
  }
  notifyListeners()
}

export function updateSession(id: string, updates: Partial<ChatSession>) {
  sessions = sessions.map(s => 
    s.id === id ? { ...s, ...updates, last_modified_at: new Date().toISOString() } : s
  )
  notifyListeners()
}

/**
 * SA-113 P1 — patch a session WITHOUT bumping `last_modified_at`.
 *
 * `updateSession` stamps "now" because it is the local echo of a user edit. A server
 * push already carries the authoritative timestamp, and re-stamping it would reorder the
 * sidebar underneath the user for a change they did not make.
 */
export function patchSessionFromServer(id: string, updates: Partial<ChatSession>) {
  let changed = false
  sessions = sessions.map((s) => {
    if (s.id !== id) return s
    changed = true
    return { ...s, ...updates }
  })
  if (changed) notifyListeners()
}

export function deleteSession(id: string) {
  sessions = sessions.filter(s => s.id !== id)
  if (currentSessionId === id) {
    setSessionIdWithPersistence(null)
  }
  notifyListeners()
}

// Function to get current session
export function getCurrentSession() {
  return sessions.find(s => s.id === currentSessionId) || null
}

export function subscribe(listener: (state: SessionStateSnapshot) => void) {
  listener({
    sessions,
    currentSessionId
  })

  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
