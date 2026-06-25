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

export function updateSession(id: string, updates: Partial<ChatSession>) {
  sessions = sessions.map(s => 
    s.id === id ? { ...s, ...updates, last_modified_at: new Date().toISOString() } : s
  )
  notifyListeners()
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
