import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

// This proof uses RedisJSON and the real credential resolver, registry, and artifact service.
vi.mock('$lib/server/redis', async () =>
  await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
)

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential,
  revokeRunCredential
} from '$lib/server/services/agentRunCredentials'
import { findControls } from '$lib/server/services/fabricRegistry'
import { POST } from './+server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('BL-829 artifact access over the authenticated Fabric HTTP route', () => {
  useRedisTestServer()

  it('binds the agent credential and refuses an access change without saving any part of the update', async () => {
    const suffix = randomUUID()
    const userId = `artifact-access-http-user-${suffix}`
    const agentId = `artifact_access_http_agent_${suffix.replaceAll('-', '')}`
    const otherAgentId = `artifact_access_http_other_${suffix.replaceAll('-', '')}`
    const sessionId = `artifact-access-http-session-${suffix}`
    const agentKey = `agent:${agentId}`
    const service = new ArtifactsService()
    let artifactId: string | null = null
    let credentialId: string | null = null
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const reply = await POST({
          locals: {},
          request: new Request(`http://127.0.0.1${incoming.url}`, {
            method: incoming.method,
            headers: incoming.headers as HeadersInit,
            body: Buffer.concat(chunks)
          })
        } as any)
        outgoing.writeHead(reply.status, Object.fromEntries(reply.headers))
        outgoing.end(Buffer.from(await reply.arrayBuffer()))
      } catch (error) {
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: String(error) }))
      }
    })

    try {
      await redis.set(agentKey, { id: agentId, user_id: userId, displayName: 'Access Probe' } as any)
      const artifact = await service.create(userId, {
        name: 'Access HTTP Probe',
        content: '<div>Original</div>',
        mode: 'edit',
        zone: 'panel',
        agent_use_enabled: true,
        agent_access_scope: 'selected',
        agent_allowlist: [agentId],
        metadata: { enforce_batshit_artifact_structure: false }
      })
      artifactId = artifact.id
      const credential = await mintRunCredential({ userId, agentId, sessionId, runtime: 'codex' })
      credentialId = credential.credentialId
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Artifact HTTP fixture has no port')

      const visibleTo = async (readerId: string) => {
        const found = await findControls({
          userId,
          agentId: readerId,
          query: `artifact.${artifact.id}.`,
          sourceType: 'artifact',
          includeDraft: true,
          limit: 200
        })
        return found.results.some((entry) => entry.controlId.startsWith(`artifact.${artifact.id}.`))
      }
      expect(await visibleTo(agentId)).toBe(true)
      expect(await visibleTo(otherAgentId)).toBe(false)

      const response = await fetch(`http://127.0.0.1:${address.port}/api/controls/use`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [AGENT_RUN_CREDENTIAL_HEADER]: credential.token
        },
        body: JSON.stringify({
          controlId: 'sys.artifact.update',
          input: {
            artifactId: artifact.id,
            content: '<div>Unauthorized replacement</div>',
            agent_access_scope: 'all'
          }
        })
      })
      const body = await response.json()

      expect(response.status).toBe(403)
      expect(body).toMatchObject({
        auth: 'agent',
        actingAgentId: agentId,
        success: false,
        error: {
          code: 'CONTROL_NOT_ALLOWED',
          details: { status: 403, code: 'ARTIFACT_ACCESS_USER_ONLY' }
        }
      })
      expect(await service.getOwned(artifact.id, userId)).toMatchObject({
        content: artifact.content,
        version: artifact.version,
        agent_use_enabled: true,
        agent_access_scope: 'selected',
        agent_allowlist: [agentId]
      })
      expect(await visibleTo(agentId)).toBe(true)
      expect(await visibleTo(otherAgentId)).toBe(false)
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (credentialId) await revokeRunCredential(credentialId, { agentId })
      if (artifactId) await service.delete(artifactId, userId)
      await redis.del(agentKey)
      await redis.execute(async (client) => {
        const recentKey = `recent_control_executions:${userId}`
        const auditKeys = await client.lRange(recentKey, 0, -1)
        await client.del([
          ...auditKeys,
          recentKey,
          `control_registry:${userId}`,
          `agent_run_credentials:${agentId}`,
          `user:${userId}:artifacts`
        ])
      })
    }
  })
})
