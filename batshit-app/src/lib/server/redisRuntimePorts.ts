/**
 * Every port a real Batshit Redis can listen on across install types: developer default 6379,
 * Mac app 5639, Pinokio 5659, dedicated native development smoke 6380, first-run test 5649. The memory-search test
 * escape in `redis.ts` must never match them, and the memory-search test harness refuses them
 * (BL-1824: one list, so a new install type cannot be refused by one and flushed by the other).
 */
export const BATSHIT_RUNTIME_REDIS_PORTS: ReadonlySet<number> = new Set([6379, 5639, 5659, 6380, 5649])
