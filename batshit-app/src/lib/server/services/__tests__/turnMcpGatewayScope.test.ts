import { beforeEach, describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { readTurnMcpGatewaySnapshot, resolveTurnMcpGatewaySelection } from '../turnMcpGatewayScope'
const owner = { userId: 'turn-scope-user', sessionId: 'turn-scope-chat', agentId: 'turn-scope-agent' }
const agent = { id: owner.agentId, user_id: owner.userId, defaultMCPGateways: ['saved'] } as any

describe('turn MCP authority', () => {
  beforeEach(async () => { await redis.set(`agent:${agent.id}`, agent) })
  it('only a vouched human selection can widen saved defaults', async () => {
    for (const authority of [undefined, { humanSelection: false }]) {
      expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, requestedGateways: ['saved', 'extra'], authority })).toEqual(['saved'])
    }
    expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, requestedGateways: ['extra'], authority: { humanSelection: true } })).toEqual(['extra'])
  })
  it('an empty narrowing disables every gateway', async () => {
    expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, requestedGateways: [], authority: { humanSelection: false } })).toEqual([])
  })
  it('a resume keeps the original wider server scope and can only narrow it', async () => {
    const scope = readTurnMcpGatewaySnapshot({ ...owner, selectedGateways: ['extra'] }, owner)
    expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, authority: { humanSelection: false, resumedScope: scope } })).toEqual(['extra'])
    expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, requestedGateways: ['extra', 'forged'], authority: { humanSelection: true, resumedScope: scope } })).toEqual(['extra'])
    expect(await resolveTurnMcpGatewaySelection({ userId: owner.userId, agent, requestedGateways: [], authority: { humanSelection: true, resumedScope: scope } })).toEqual([])
  })
  it('a missing, old or mismatched snapshot grants nothing', () => {
    for (const snapshot of [null, { ...owner }, { ...owner, userId: 'other', selectedGateways: ['extra'] }, { ...owner, agentId: 'other', selectedGateways: ['extra'] }, { ...owner, sessionId: 'other', selectedGateways: ['extra'] }]) {
      expect(readTurnMcpGatewaySnapshot(snapshot, owner)).toEqual([])
    }
  })
})
