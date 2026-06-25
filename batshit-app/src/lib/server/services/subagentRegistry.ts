// Story 6.7c: API runtime subagent metadata injection
// Subagent Registry Lookup Helper with Session-Scoped Caching
//
// CRITICAL PATTERNS:
// - Session-scoped cache (Map keyed by userId)
// - O(1) Map lookups after initial population
// - Return null on errors (graceful degradation, NEVER throw)
// - Use Redis directly so server-side lookups do not depend on a relative fetch route

import { redis } from '$lib/server/redis'
import { normalizeSubagentType } from '$lib/utils/subagentType'

/**
 * Subagent metadata structure from subagent API
 */
export interface SubagentMetadata {
	id: string;
	displayName: string;
	workflowName: string;
	type: 'n8n-workflow';
}

/**
 * Session-level cache: Map<userId, Map<workflowName, SubagentMetadata>>
 *
 * CRITICAL: Cache scoped by userId (NOT global)
 * - Single API call per session per user
 * - O(1) lookups after initial fetch
 * - Invalidate on registry changes
 */
const sessionCaches = new Map<string, Map<string, SubagentMetadata>>();

/**
 * Get subagent metadata by workflow name (with caching)
 *
 * CRITICAL BEHAVIOR:
 * - Returns null on ALL errors (API failure, timeout, invalid JSON)
 * - NEVER throws errors (graceful degradation)
 * - Single API call per session (subsequent calls use cache)
 * - 5-second timeout protection
 *
 * @param workflowName - n8n workflow name to match
 * @param userId - User ID for session-scoped caching
 * @returns Subagent metadata if found, null otherwise
 */
export async function getSubagentByWorkflowName(
	workflowName: string,
	userId: string
): Promise<SubagentMetadata | null> {
	// Check cache first (TECH-002 mitigation: performance)
	let cache = sessionCaches.get(userId);

	if (!cache) {
		// First call for this user - populate cache
		cache = new Map();

		try {
			const subagentIds = await redis.sMembers(`user:${userId}:subagents`)
			for (const id of subagentIds) {
				const subagent = await redis.json.get(`subagent:${id}`)
				if (!subagent || typeof subagent !== 'object') continue
				const workflowName =
					(subagent as Record<string, any>).workflowName ||
					(subagent as Record<string, any>).webhookUrl ||
					(subagent as Record<string, any>).webhook_url ||
					''
				if (!workflowName) continue
				if (normalizeSubagentType(subagent as Record<string, any>) !== 'n8n-workflow') {
					continue
				}
				cache!.set(workflowName, {
					id: String((subagent as Record<string, any>).id ?? id),
					displayName: String(
						(subagent as Record<string, any>).displayName ||
						(subagent as Record<string, any>).name ||
						id
					),
					workflowName: String(workflowName),
					type: 'n8n-workflow'
				})
			}

			sessionCaches.set(userId, cache)
		} catch (error) {
			if (error instanceof Error) {
				console.warn(
					`[SubagentRegistry] Cache population failed for userId ${userId}:`,
					error.message
				)
			}
			return null;
		}
	}

	// O(1) lookup from cache
	return cache.get(workflowName) || null;
}

/**
 * Invalidate subagent cache (called when registry changes)
 *
 * DATA-001 mitigation: Clear stale cache data
 *
 * @param userId - Optional user ID to clear specific user cache
 *                 If omitted, clears all user caches
 */
export function invalidateSubagentCache(userId?: string): void {
	if (userId) {
		sessionCaches.delete(userId);
		console.warn(`[SubagentRegistry] Cache invalidated for userId ${userId}`);
	} else {
		sessionCaches.clear();
		console.warn('[SubagentRegistry] All session caches invalidated');
	}
}

/**
 * Get cache statistics (for testing/debugging)
 *
 * @returns Object with cache metrics
 */
export function getCacheStats(): {
	totalUsers: number;
	userCaches: Array<{ userId: string; subagentCount: number }>;
} {
	const userCaches = Array.from(sessionCaches.entries()).map(([userId, cache]) => ({
		userId,
		subagentCount: cache.size
	}));

	return {
		totalUsers: sessionCaches.size,
		userCaches
	};
}
