import { describe, expect, it } from 'vitest'
import { fileReadSourceFromProof, hasFileReadProofShape as hasProofShape, isFileReadLocator, readFileReadSource, type FileReadProof } from './fileReadSource'

/**
 * SA-137 (D4): a stored `fileReadSource` is exactly a v1 record or nothing, and the zip adapter
 * builds one only from a run's proof that names this chat, this reply and this part.
 */

const proof: FileReadProof = {
  version: 1,
  userId: 'user-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  messageId: 'reply-1',
  toolCallId: 'call-1',
  backend: 'local',
  workspaceRoot: '/work/project',
  rootIdentity: '16777232:9001',
  cwd: '/work/project',
  reads: [
    { part: null, file: 'src/a.js', locator: 'src/a.js', view: { kind: 'whole', numbering: 'none' } }
  ],
  seal: 'x'.repeat(43)
}

const binding = { sessionId: 'session-1', messageId: 'reply-1', toolCallId: 'call-1', part: null }

describe('fileReadSource (SA-137)', () => {
  it('builds the descriptor from a proof that names this chat, reply and part', () => {
    const source = fileReadSourceFromProof(proof, binding)
    expect(source).toEqual({
      version: 1,
      owner: { userId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', messageId: 'reply-1', toolCallId: 'call-1' },
      backend: 'local',
      workspaceRoot: '/work/project',
      rootIdentity: '16777232:9001',
      cwd: '/work/project',
      locator: 'src/a.js',
      view: { kind: 'whole', numbering: 'none' }
    })
    expect(readFileReadSource(source)).toEqual(source)
  })

  it('builds nothing for another chat, another reply, another call, another part, another file or no call id', () => {
    expect(fileReadSourceFromProof(proof, { ...binding, sessionId: 'session-2' })).toBeNull()
    expect(fileReadSourceFromProof(proof, { ...binding, messageId: 'reply-2' })).toBeNull()
    expect(fileReadSourceFromProof(proof, { ...binding, part: 0 })).toBeNull()
    expect(fileReadSourceFromProof(proof, { ...binding, file: 'src/b.js' })).toBeNull()
    expect(fileReadSourceFromProof(proof, { ...binding, toolCallId: undefined })).toBeNull()
    expect(fileReadSourceFromProof(proof, { ...binding, toolCallId: 'call-2' })).toBeNull()
    expect(fileReadSourceFromProof({ ...proof, extra: true }, binding)).toBeNull()
    expect(fileReadSourceFromProof({ ...proof, backend: 'docker' }, binding)).toBeNull()
    // Two entries for one part are ambiguous.
    expect(fileReadSourceFromProof({ ...proof, reads: [proof.reads[0], proof.reads[0]] }, binding)).toBeNull()
  })

  it('reads only an exact v1 record', () => {
    const source = fileReadSourceFromProof(proof, binding)!
    expect(readFileReadSource({ ...source, version: 2 })).toBeNull()
    expect(readFileReadSource({ ...source, extra: 1 })).toBeNull()
    expect(readFileReadSource({ ...source, workspaceRoot: 'relative' })).toBeNull()
    expect(readFileReadSource({ ...source, rootIdentity: '1-2' })).toBeNull()
    expect(readFileReadSource({ ...source, owner: { ...source.owner, toolCallId: '' } })).toBeNull()
    expect(readFileReadSource({ ...source, view: { kind: 'whole', numbering: 'some' } })).toBeNull()
    expect(readFileReadSource({ ...source, view: { kind: 'lines', script: '/x/p' } })).toBeNull()
    expect(readFileReadSource({ ...source, view: { kind: 'head', lines: 0 } })).toBeNull()
    expect(readFileReadSource({ ...source, view: { kind: 'nl' } })).toBeNull()
    expect(readFileReadSource(null)).toBeNull()
  })

  it('carries whether live reads were on at tool time, only as a boolean, from the proof to the descriptor', () => {
    const hasFileReadProofShape = hasProofShape
    const on = fileReadSourceFromProof({ ...proof, liveReadsOn: true }, binding)!
    expect(on.liveReadsOn).toBe(true)
    expect(readFileReadSource(on)).toEqual(on)
    expect(fileReadSourceFromProof({ ...proof, liveReadsOn: false }, binding)!.liveReadsOn).toBe(false)
    // Absent stays absent (a typed read stamped before the field, a Bash read of P1): never "on".
    expect(Object.hasOwn(fileReadSourceFromProof(proof, binding)!, 'liveReadsOn')).toBe(false)
    expect(readFileReadSource({ ...on, liveReadsOn: 'yes' })).toBeNull()
    expect(fileReadSourceFromProof({ ...proof, liveReadsOn: 1 }, binding)).toBeNull()
    expect(hasFileReadProofShape({ ...proof, liveReadsOn: true })).toBe(true)
    expect(hasFileReadProofShape({ ...proof, liveReadsOn: 'true' })).toBe(false)
    expect(hasFileReadProofShape(proof)).toBe(true)
  })

  it('takes a locator only inside its root', () => {
    for (const locator of ['src/a.js', 'a', '.env', 'dir/sub/file.ts']) expect(isFileReadLocator(locator), locator).toBe(true)
    for (const locator of ['', '/abs/a.js', '../a.js', 'src/../a.js', 'src/./a.js', 'src//a.js', 'src\\a.js', 'a\nb', '.']) {
      expect(isFileReadLocator(locator), JSON.stringify(locator)).toBe(false)
    }
  })

  it.each([true, false])('keeps the actual Apple origin and explicit live-read setting %s', (liveReadsOn) => {
    const apple = {
      ...proof,
      backend: 'apple_container',
      liveReadsOn,
      reads: [{ ...proof.reads[0], view: { kind: 'typed', startLine: 1, endLine: null } }]
    }
    expect(hasProofShape(apple)).toBe(true)
    const source = fileReadSourceFromProof(apple, binding)!
    expect(source).toMatchObject({ backend: 'apple_container', liveReadsOn, view: { kind: 'typed', startLine: 1, endLine: null } })
    expect(Object.hasOwn(source, 'liveReadsOn')).toBe(true)
    expect(readFileReadSource(source)).toEqual(source)
  })

  it.each(['apple_container', 'docker_sandbox'] as const)('requires an explicit boolean on every %s proof/source', (backend) => {
    const sandbox = { ...proof, backend, liveReadsOn: true }
    const source = fileReadSourceFromProof(sandbox, binding)!
    expect(source).toMatchObject({ backend, liveReadsOn: true })
    for (const liveReadsOn of [undefined, null, 1, 'true']) {
      expect(hasProofShape({ ...sandbox, liveReadsOn }), String(liveReadsOn)).toBe(false)
      expect(fileReadSourceFromProof({ ...sandbox, liveReadsOn }, binding), String(liveReadsOn)).toBeNull()
      expect(readFileReadSource({ ...source, liveReadsOn }), String(liveReadsOn)).toBeNull()
    }
    const { liveReadsOn: _proofBit, ...missingProofBit } = sandbox
    const { liveReadsOn: _sourceBit, ...missingSourceBit } = source
    expect(hasProofShape(missingProofBit)).toBe(false)
    expect(fileReadSourceFromProof(missingProofBit, binding)).toBeNull()
    expect(readFileReadSource(missingSourceBit)).toBeNull()
  })

  it('accepts a Docker Sandbox origin with its explicit setting bit, true or false, from proof to descriptor', () => {
    for (const liveReadsOn of [true, false]) {
      const docker = { ...proof, backend: 'docker_sandbox', liveReadsOn }
      expect(hasProofShape(docker)).toBe(true)
      const source = fileReadSourceFromProof(docker, binding)!
      expect(source).toMatchObject({ backend: 'docker_sandbox', liveReadsOn })
      expect(Object.hasOwn(source, 'liveReadsOn')).toBe(true)
      expect(readFileReadSource(source)).toEqual(source)
    }
  })

  it('refuses every backend that is not local, apple_container or docker_sandbox', () => {
    const apple = { ...proof, backend: 'apple_container', liveReadsOn: true }
    const source = fileReadSourceFromProof(apple, binding)!
    for (const backend of ['docker', 'apple-container', 'docker-sandbox', 'sandbox', 'remote', 'container', '', undefined, null, 1]) {
      expect(hasProofShape({ ...apple, backend }), String(backend)).toBe(false)
      expect(fileReadSourceFromProof({ ...apple, backend }, binding), String(backend)).toBeNull()
      expect(readFileReadSource({ ...source, backend }), String(backend)).toBeNull()
    }
  })

  it('lets only the original Local shape omit the setting bit', () => {
    const local = fileReadSourceFromProof(proof, binding)!
    expect(Object.hasOwn(local, 'liveReadsOn')).toBe(false)
    expect(readFileReadSource(local)).toEqual(local)
    expect(hasProofShape(proof)).toBe(true)
    // A non-boolean Local bit is still refused.
    expect(readFileReadSource({ ...local, liveReadsOn: 'yes' })).toBeNull()
  })
})
