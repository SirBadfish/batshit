import { redis } from '$lib/server/redis'

/**
 * Generate a standardized message ID with human-readable format
 * Pattern: msg_{YYYYMMDD-HHMMSS}_{counter}
 * Counter is per-session and prevents collisions
 *
 * @param sessionId - The session ID for counter isolation
 * @returns Promise<string | null> - Generated message ID or null on failure
 *
 * Example: msg_20251020-150822_0001
 */
export async function generateMessageId(sessionId: string): Promise<string | null> {
  try {
    // Create human-readable timestamp: YYYYMMDD-HHMMSS
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')

    const timestamp = `${year}${month}${day}-${hours}${minutes}${seconds}`

    // Get and increment counter atomically (Redis INCR)
    // CRITICAL: Using INCR for atomicity - prevents race conditions
    const counter = await redis.incr(`message_counter:${sessionId}`)

    // Format: msg_20251020-150822_0001
    // Zero-pad to 4 digits (supports up to 9999 messages per session)
    const counterStr = counter.toString().padStart(4, '0')
    return `msg_${timestamp}_${counterStr}`
  } catch (error) {
    console.error('Failed to generate message ID:', error)
    return null // Graceful degradation
  }
}
