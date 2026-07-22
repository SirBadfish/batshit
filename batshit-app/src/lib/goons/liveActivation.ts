export type GoonLiveActivationTicket = {
  key: string
  generation: number
}

/**
 * Small deterministic gate for mounted same-id replacement. A key is accepted
 * only after the hidden engine succeeds; failed keys require an explicit retry,
 * and a superseded async load can never become the accepted generation.
 */
export class GoonLiveActivationGate {
  private generation = 0
  private acceptedKey = ''
  private pending: GoonLiveActivationTicket | null = null
  private failedKey = ''

  request(key: string): GoonLiveActivationTicket | null {
    if (!key) return null
    if (this.acceptedKey === key) return null
    if (this.pending?.key === key) return null
    if (this.failedKey === key) return null
    const ticket = { key, generation: ++this.generation }
    this.pending = ticket
    return ticket
  }

  accept(ticket: GoonLiveActivationTicket) {
    if (!this.isPending(ticket)) return false
    this.acceptedKey = ticket.key
    this.pending = null
    this.failedKey = ''
    return true
  }

  fail(ticket: GoonLiveActivationTicket) {
    if (!this.isPending(ticket)) return false
    this.pending = null
    this.failedKey = ticket.key
    return true
  }

  retry(key: string) {
    if (!key || this.failedKey !== key) return false
    this.failedKey = ''
    return true
  }

  isAccepted(key: string) {
    return this.acceptedKey === key
  }

  getFailedKey() {
    return this.failedKey
  }

  private isPending(ticket: GoonLiveActivationTicket) {
    return (
      this.pending?.key === ticket.key &&
      this.pending.generation === ticket.generation
    )
  }
}
