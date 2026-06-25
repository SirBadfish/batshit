// Session ID generation utility

/**
 * Generate a session ID in Batshit format: MM-DD-YY-hh_mm-and-ssS-am/pm
 */
export function generateSessionId(): string {
  const now = new Date()
  
  // Get date components
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const year = String(now.getFullYear()).slice(-2)
  
  // Get time components
  let hours = now.getHours()
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')
  
  // Convert to 12-hour format
  const ampm = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  const hoursStr = String(hours).padStart(2, '0')
  
  // Construct the ID
  return `${month}-${day}-${year}-${hoursStr}_${minutes}-and-${seconds}${milliseconds}-${ampm}`
}

/**
 * Parse a session ID to get its timestamp
 */
export function parseSessionId(sessionId: string): Date | null {
  try {
    const parts = sessionId.split('-')
    if (parts.length !== 6) return null
    
    const month = parseInt(parts[0])
    const day = parseInt(parts[1])
    const year = 2000 + parseInt(parts[2])
    const timeParts = parts[3].split('_')
    let hours = parseInt(timeParts[0])
    const minutes = parseInt(timeParts[1])
    const secondsMs = parts[4].replace('and', '')
    const seconds = parseInt(secondsMs.slice(0, 2))
    const milliseconds = parseInt(secondsMs.slice(2))
    const ampm = parts[5]
    
    // Adjust hours for PM
    if (ampm === 'pm' && hours !== 12) {
      hours += 12
    } else if (ampm === 'am' && hours === 12) {
      hours = 0
    }
    
    return new Date(year, month - 1, day, hours, minutes, seconds, milliseconds)
  } catch {
    return null
  }
}