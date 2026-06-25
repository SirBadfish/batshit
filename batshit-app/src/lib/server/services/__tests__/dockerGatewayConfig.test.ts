import { describe, expect, it } from 'vitest'

import {
  buildDockerGatewayUrl,
  buildDockerGatewayUpstreamUrl,
  resolveDockerGatewayBaseUrl
} from '../dockerGatewayConfig'

describe('dockerGatewayConfig', () => {
  it('uses the explicit Docker MCP gateway URL when no port override is present', () => {
    expect(
      resolveDockerGatewayBaseUrl({
        DOCKER_MCP_GATEWAY_URL: 'http://localhost:5608/mcp'
      })
    ).toBe('http://localhost:5608')
  })

  it('lets the dedicated port override win when both URL and port exist', () => {
    expect(
      resolveDockerGatewayBaseUrl({
        DOCKER_MCP_GATEWAY_URL: 'http://localhost:8080',
        DOCKER_MCP_GATEWAY_PORT: '5608'
      })
    ).toBe('http://localhost:5608')
  })

  it('derives the local gateway URL from DOCKER_MCP_GATEWAY_PORT', () => {
    expect(
      resolveDockerGatewayBaseUrl({
        DOCKER_MCP_GATEWAY_PORT: '5608'
      })
    ).toBe('http://localhost:5608')
  })

  it('derives the host gateway URL from DOCKER_MCP_GATEWAY_PORT inside Dockerized Batshit', () => {
    expect(
      resolveDockerGatewayBaseUrl({
        BATSHIT_CONTAINERIZED: '1',
        DOCKER_MCP_GATEWAY_PORT: '5608'
      })
    ).toBe('http://host.docker.internal:5608')
  })

  it('rewrites loopback Docker MCP gateway URLs inside Dockerized Batshit', () => {
    expect(
      resolveDockerGatewayBaseUrl({
        BATSHIT_CONTAINERIZED: '1',
        DOCKER_MCP_GATEWAY_URL: 'http://localhost:5608/mcp'
      })
    ).toBe('http://host.docker.internal:5608')
  })

  it('falls back to the normal Docker MCP Gateway port', () => {
    expect(resolveDockerGatewayBaseUrl({})).toBe('http://localhost:8080')
  })

  it('falls back to the host gateway URL inside Dockerized Batshit', () => {
    expect(resolveDockerGatewayBaseUrl({ BATSHIT_CONTAINERIZED: '1' })).toBe(
      'http://host.docker.internal:8080'
    )
  })

  it('routes MCP client traffic through the in-app proxy inside Dockerized Batshit', () => {
    expect(
      buildDockerGatewayUrl('/mcp', {
        BATSHIT_CONTAINERIZED: '1',
        PORT: '3000',
        DOCKER_MCP_GATEWAY_URL: 'http://host.docker.internal:8080'
      } as any)
    ).toBe('http://127.0.0.1:3000/api/mcp/gateway/proxy/mcp')
  })

  it('keeps the upstream URL separate from the Docker proxy URL', () => {
    expect(
      buildDockerGatewayUpstreamUrl('/mcp', {
        BATSHIT_CONTAINERIZED: '1',
        DOCKER_MCP_GATEWAY_URL: 'http://host.docker.internal:8080'
      } as any)
    ).toBe('http://host.docker.internal:8080/mcp')
  })
})
