import { afterEach, describe, expect, it } from 'vitest'

import { isBlockedBatshitServerGatewayUrl } from '../mcpGatewayPolicy'

// A custom MCP gateway must never point at Batshit's own streamable MCP helper: it has no login and
// runs its tools with the instance token (BL-205, BL-207).
describe('isBlockedBatshitServerGatewayUrl', () => {
  const savedPort = process.env.BATSHIT_MCP_STREAMABLE_PORT
  afterEach(() => {
    if (savedPort === undefined) delete process.env.BATSHIT_MCP_STREAMABLE_PORT
    else process.env.BATSHIT_MCP_STREAMABLE_PORT = savedPort
  })

  it('blocks the Mac app helper (5601) and the native lane helper (5611) on every loopback spelling', () => {
    delete process.env.BATSHIT_MCP_STREAMABLE_PORT
    for (const port of ['5601', '5611']) {
      for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'LOCALHOST']) {
        expect(isBlockedBatshitServerGatewayUrl(`http://${host}:${port}/mcp`), `${host}:${port}`).toBe(true)
      }
    }
  })

  it('blocks every other spelling of this computer (review finding 4)', () => {
    delete process.env.BATSHIT_MCP_STREAMABLE_PORT
    for (const host of [
      'localhost.',
      'LOCALHOST.',
      'app.localhost',
      '[::ffff:127.0.0.1]',
      '[0:0:0:0:0:ffff:7f00:1]',
      '[::]',
      '[::ffff:0.0.0.0]',
      '127.0.0.2',
      '127.255.255.254',
      '127.1',
      '2130706433',
      '0x7f.1'
    ]) {
      expect(isBlockedBatshitServerGatewayUrl(`http://${host}:5601/mcp`), host).toBe(true)
      expect(isBlockedBatshitServerGatewayUrl(`http://${host}:5610/sse`), host).toBe(true)
    }
    for (const host of ['[::ffff:10.0.0.1]', '128.0.0.1', '10.127.0.1', 'localhost.example.com', 'notlocalhost']) {
      expect(isBlockedBatshitServerGatewayUrl(`http://${host}:5601/mcp`), host).toBe(false)
    }
  })

  it('blocks the helper port this instance was started with', () => {
    process.env.BATSHIT_MCP_STREAMABLE_PORT = '5642'
    expect(isBlockedBatshitServerGatewayUrl('http://127.0.0.1:5642/mcp')).toBe(true)
    expect(isBlockedBatshitServerGatewayUrl('http://localhost:5642')).toBe(true)
  })

  it("blocks /mcp and /sse on batshit-server's own port, Mac app (5600) and native lane (5610)", () => {
    delete process.env.BATSHIT_MCP_STREAMABLE_PORT
    for (const port of ['5600', '5610']) {
      expect(isBlockedBatshitServerGatewayUrl(`http://localhost:${port}/mcp`)).toBe(true)
      expect(isBlockedBatshitServerGatewayUrl(`http://127.0.0.1:${port}/sse/`)).toBe(true)
      expect(isBlockedBatshitServerGatewayUrl(`http://localhost:${port}/api/v1/health`)).toBe(false)
    }
  })

  it('leaves real gateways alone', () => {
    process.env.BATSHIT_MCP_STREAMABLE_PORT = '5611'
    expect(isBlockedBatshitServerGatewayUrl('http://localhost:8080/mcp')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl('http://127.0.0.1:5678/mcp-server/http')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl('https://mcp.example.com:5611/mcp')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl('http://192.168.1.20:5601/mcp')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl('not a url')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl(null)).toBe(false)
  })

  it('ignores a helper port setting that is not a port', () => {
    process.env.BATSHIT_MCP_STREAMABLE_PORT = 'abc'
    expect(isBlockedBatshitServerGatewayUrl('http://localhost:8080/mcp')).toBe(false)
    expect(isBlockedBatshitServerGatewayUrl('http://localhost:5611/mcp')).toBe(true)
  })
})
