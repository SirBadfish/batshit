/**
 * MCP Discovery API Endpoint
 *
 * Discovers MCPs installed in Docker Desktop
 * Returns them in a format the UI can display
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dockerMCPClient } from '$lib/server/services/dockerMCPClient';
import { requireAdmin } from '$lib/server/services/routeSecurity';

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals);
  if (!admin.ok) return admin.response;

  try {
    // Check if Docker is available first
    const dockerStatus = await dockerMCPClient.isDockerAvailable();

    if (!dockerStatus.available) {
      // Return helpful message if Docker isn't running
      return json({
        available: false,
        message: dockerStatus.message,
        action: dockerStatus.action,
        note: dockerStatus.note,
        mcps: []
      });
    }

    // Discover all MCPs the user has installed in Docker Desktop
    const mcps = await dockerMCPClient.discoverMCPs();

    // Format for UI display
    const formattedMCPs = mcps.map(mcp => ({
      name: mcp.name,
      version: mcp.version,
      description: mcp.description,
      toolCount: mcp.tools.length,
      tools: mcp.tools.map(t => ({
        name: t.name,
        description: t.description
      }))
    }));

    return json({
      available: true,
      mcps: formattedMCPs,
      count: formattedMCPs.length,
      message: formattedMCPs.length > 0
        ? `Found ${formattedMCPs.length} MCPs installed in Docker Desktop`
        : 'No MCPs found. Add them via Docker Desktop catalog!'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Failed to discover MCPs:', error);
    return json({
      available: false,
      message: 'Failed to discover MCPs',
      error: errorMessage,
      mcps: []
    });
  }
};
