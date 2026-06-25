#!/usr/bin/env node

/**
 * Batshit-Server MCP Server - streamlined retained tool set for Lane A transition
 * Currently exposed: fetch_zip + Dynamic MCP + Control Registry.
 * Provides MCP tools for Batshit tool orchestration paths.
 */

// Load environment variables from .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const path = require('path');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { builtInService } = require('../services');
const { enhancedBuiltInTools } = require('./enhanced-tools');

// Log to stderr immediately
console.error('MCP Server: Script started');

// Configure logger for MCP mode (stderr only)
logger.transports.forEach(transport => {
  if (transport.name === 'console') {
    transport.stderrOnly = true;
  }
});

class BatshitMcpServer {
  constructor() {
    logger.error('MCP Server: Constructor called');
    
    this.server = new Server(
      {
        name: 'batshit-server-mcp',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.batshitServerApiUrl = process.env.BATSHIT_SERVER_URL || 'http://localhost:5600/api/v1';
    this.setupHandlers();
  }

  resolveProjectPath(projectPath) {
    if (typeof projectPath === 'string' && projectPath.trim() !== '') {
      return projectPath;
    }

    if (typeof process.env.BATSHIT_PROJECT_ROOT === 'string' && process.env.BATSHIT_PROJECT_ROOT.trim() !== '') {
      return process.env.BATSHIT_PROJECT_ROOT;
    }

    return path.resolve(__dirname, '../../../../');
  }

  normalizeToolArgs(toolName, args) {
    const normalized = { ...(args || {}) };

    if (!normalized.projectPath) {
      normalized.projectPath = normalized.project_path || normalized.rootPath || normalized.cwd;
    }

    const assignFirst = (targetKey, ...aliases) => {
      if (normalized[targetKey]) return;
      for (const alias of aliases) {
        if (normalized[alias]) {
          normalized[targetKey] = normalized[alias];
          return;
        }
      }
    };

    if (toolName === 'batshit_server_fetch_zip') {
      assignFirst('zipId', 'zip_id', 'id');
      assignFirst('maxChars', 'max_chars', 'max', 'limit');
    }

    return normalized;
  }

  resolveBuiltInMethodName(toolName) {
    const cleanName = toolName.replace(/^batshit_server_/, '');
    return cleanName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  resolveBatshitServiceToken() {
    return process.env.BATSHIT_TOKEN || '';
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.error('MCP Server: ListTools request received');
      
      // Use enhanced tool descriptions with full usage instructions
      // This eliminates the need for a separate MCP system prompt
      const builtInTools = enhancedBuiltInTools;
      
      // Only expose built-in batshit-server tools (others are parked)
      return {
        tools: [...builtInTools]
      };
    });
    
    // Handle tool calls
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => await this.handleToolCall(request)
    );
  }

  async handleToolCall(request) {
    // Debug logging to stderr (visible in terminal)
    logger.error('MCP Tool Call Received:', JSON.stringify(request, null, 2));
    
    const { name, arguments: args } = request.params;

    try {
      // All built-in tool names (with batshit_server_ prefix)
      const builtInTools = [
        // Retained non-artifact tools
        'batshit_server_fetch_zip'
      ];

      // SA-009: Dynamic MCP Tools (call Batshit API, not local service)
      if (name === 'batshit_server_dynamic_mcp_find') {
        return await this.handleDynamicMcpFind(args);
      }
      if (name === 'batshit_server_dynamic_mcp_use') {
        return await this.handleDynamicMcpUse(args);
      }
      if (name === 'mcp_artifact_find') {
        return await this.handleControlFind({
          ...(args || {}),
          allowedControlIds: ['use.artifact.*']
        });
      }
      if (name === 'mcp_artifact_use') {
        return await this.handleControlUse({
          ...(args || {}),
          allowedControlIds: ['use.artifact.*']
        });
      }
      if (name === 'mcp_fabric_find') {
        return await this.handleControlFind(args);
      }
      if (name === 'mcp_fabric_use') {
        return await this.handleControlUse(args);
      }

      if (builtInTools.includes(name)) {
        return await this.handleBuiltInTool(name, args);
      }

      // Everything else is parked/unknown
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  }

  async handleBuiltInTool(toolName, args) {
    const normalizedArgs = this.normalizeToolArgs(toolName, args);
    const { projectPath, ...params } = normalizedArgs;
    const effectiveProjectPath = this.resolveProjectPath(projectPath);

    try {
      // Remove batshit_server_ prefix and convert to camelCase service method name
      const methodName = this.resolveBuiltInMethodName(toolName);
      
      if (typeof builtInService[methodName] !== 'function') {
        throw new Error(`Built-in tool method not found: ${methodName}`);
      }
      
      // Call the built-in service method
      const result = await builtInService[methodName](effectiveProjectPath, params);
      
      // COOL TOOLS FIX: Preserve structured data instead of stringifying!
      // This allows our frontend to receive the actual data structure
      // instead of quadruple-escaped JSON strings
      
      const responseText = JSON.stringify(result, null, 2);
      
      return {
        content: [
          {
            type: 'text',
            text: responseText
          },
        ],
      };
    } catch (error) {
      throw new Error(`Built-in tool error: ${error.message}`);
    }
  }

  /**
   * SA-009: Dynamic MCP Find
   * Search for available MCP tools across all configured gateways
   * Calls the Batshit API endpoint
   */
  async handleDynamicMcpFind(args) {
    let effectiveTool = '';
    let effectiveGroup = '';
    try {
      const payload = (args && typeof args === 'object' && args.value && typeof args.value === 'object')
        ? args.value
        : (args || {});

      const {
        userId,
        agentId,
        query,
        tool,
        toolName,
        group,
        mcpGroup,
        exact,
        limit,
        schema,
        includeEnabled,
        selectedGateways
      } = payload;

      effectiveTool = tool || toolName || '';
      effectiveGroup = group ?? mcpGroup ?? '';

      if (!userId) {
        throw new Error('userId is required for dynamic MCP find');
      }
      if (!query && !effectiveTool && !effectiveGroup) {
        throw new Error('query, tool, or group is required for dynamic MCP find');
      }

      // Batshit frontend URL
      const batshitUrl = process.env.BATSHIT_FRONTEND_URL || 'http://localhost:5620';

      // Service token for auth
      const serviceToken = this.resolveBatshitServiceToken();
      if (!serviceToken) {
        throw new Error('BATSHIT_TOKEN not configured - required for dynamic MCP');
      }

      const logLabel = effectiveTool
        ? `tool="${effectiveTool}"`
        : effectiveGroup
          ? `group="${effectiveGroup}"`
          : `query="${query}"`;
      logger.info(`[Dynamic MCP Find] Searching for ${logLabel} for user ${userId}`);

      const requestPayload = {
        userId,
        ...(agentId ? { agentId } : {}),
        ...(query ? { query } : {}),
        ...(effectiveTool ? { tool: effectiveTool } : {}),
        ...(effectiveGroup ? { group: effectiveGroup } : {}),
        ...(typeof exact === 'boolean' ? { exact } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(schema ? { schema } : {}),
        ...(typeof includeEnabled === 'boolean' ? { includeEnabled } : {}),
        ...(Array.isArray(selectedGateways) ? { selectedGateways } : {})
      };

      const response = await axios.post(
        `${batshitUrl}/api/mcp/tools/find`,
        requestPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-batshit-service-token': serviceToken,
            'x-batshit-user-id': userId
          },
          timeout: 30000
        }
      );

      const result = response.data;

      if (result.error) {
        throw new Error(result.error);
      }

      logger.info(`[Dynamic MCP Find] Found ${result.totalMatches} matches, returning ${result.results?.length || 0}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      logger.error(`[Dynamic MCP Find] Error: ${error.message}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              hint: 'Check that the query is valid and try again.'
            }, null, 2)
          }
        ]
      };
    }
  }

  /**
   * SA-009: Dynamic MCP Use
   * Execute any MCP tool by name
   * Calls the Batshit API endpoint
   */
  async handleDynamicMcpUse(args) {
    let effectiveToolName = 'unknown';
    try {
      const payload = (args && typeof args === 'object' && args.value && typeof args.value === 'object')
        ? args.value
        : (args || {});

      const {
        userId,
        agentId,
        toolName,
        tool,
        tool_name,
        params,
        selectedGateways,
        ...extraArgs
      } = payload;

      effectiveToolName = toolName || tool || tool_name || 'unknown';

      if (!userId) {
        throw new Error('userId is required for dynamic MCP use');
      }
      if (!effectiveToolName) {
        throw new Error('toolName is required for dynamic MCP use');
      }

      // SA-009: Forgiving params handling
      // If agent put tool arguments at top level instead of inside params, auto-fix it
      let effectiveParams = params || {};

      if (typeof effectiveParams === 'string') {
        try {
          const parsedParams = JSON.parse(effectiveParams);
          if (parsedParams && typeof parsedParams === 'object') {
            effectiveParams = parsedParams;
          }
        } catch {
          // Keep original string if it is not JSON
        }
      }

      if (Object.keys(extraArgs).length > 0) {
        logger.warn(`[Dynamic MCP Use] Found ${Object.keys(extraArgs).length} extra args at top level - moving to params: ${Object.keys(extraArgs).join(', ')}`);
        effectiveParams = { ...effectiveParams, ...extraArgs };
      }

      // Batshit frontend URL
      const batshitUrl = process.env.BATSHIT_FRONTEND_URL || 'http://localhost:5620';

      // Service token for auth
      const serviceToken = this.resolveBatshitServiceToken();
      if (!serviceToken) {
        throw new Error('BATSHIT_TOKEN not configured - required for dynamic MCP');
      }

      // SA-009: Debug logging for n8n tool-dispatch issues
      logger.info(`[Dynamic MCP Use] Executing ${effectiveToolName} for user ${userId}`);
      logger.info(`[Dynamic MCP Use] Params received: ${JSON.stringify(effectiveParams)}`);

      const response = await axios.post(
        `${batshitUrl}/api/mcp/tools/execute`,
        {
          userId,
          ...(agentId ? { agentId } : {}),
          ...(Array.isArray(selectedGateways) ? { selectedGateways } : {}),
          toolName: effectiveToolName,
          params: effectiveParams
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-batshit-service-token': serviceToken,
            'x-batshit-user-id': userId
          },
          timeout: 60000 // 60s timeout for tool execution
        }
      );

      const result = response.data;

      if (!result.success) {
        throw new Error(result.error || 'Tool execution failed');
      }

      logger.info(`[Dynamic MCP Use] ${effectiveToolName} completed in ${result.executionTimeMs}ms`);

      // Return structured payload so frontend can show actual executed tool name
      const resultPayload = {
        toolName: result.toolName || effectiveToolName,
        executionTimeMs: result.executionTimeMs,
        result: result.result
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultPayload, null, 2)
          }
        ]
      };
    } catch (error) {
      // SA-009: Capture full error details for debugging
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        apiError: error.response?.data?.error,
        apiResult: error.response?.data
      };
      logger.error(`[Dynamic MCP Use] Error: ${JSON.stringify(errorDetails)}`);

      // Return helpful error to agent
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.response?.data?.error || error.message,
              toolName: effectiveToolName || 'unknown',
              status: error.response?.status,
              hint: 'Use batshit_server_dynamic_mcp_find to discover available tools and their required parameters.'
            }, null, 2)
          }
        ]
      };
    }
  }

  /**
   * Control Registry Find
   * Discover control capabilities by query/tags/source/risk.
   */
  async handleControlFind(args) {
    try {
      const payload = (args && typeof args === 'object' && args.value && typeof args.value === 'object')
        ? args.value
        : (args || {});

      const {
        userId,
        agentId,
        query,
        tags,
        sourceType,
        riskLevel,
        includeSchema,
        includeDraft,
        limit,
        allowedControlIds
      } = payload;

      if (!userId) {
        throw new Error('userId is required for control find');
      }

      const batshitUrl = process.env.BATSHIT_FRONTEND_URL || 'http://localhost:5620';
      const serviceToken = this.resolveBatshitServiceToken();
      if (!serviceToken) {
        throw new Error('BATSHIT_TOKEN not configured - required for Fabric Registry');
      }

      const response = await axios.post(
        `${batshitUrl}/api/controls/find`,
        {
          userId,
          ...(agentId ? { agentId } : {}),
          ...(query ? { query } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
          ...(sourceType ? { sourceType } : {}),
          ...(riskLevel ? { riskLevel } : {}),
          ...(typeof includeSchema === 'boolean' ? { includeSchema } : {}),
          ...(typeof includeDraft === 'boolean' ? { includeDraft } : {}),
          ...(typeof limit === 'number' ? { limit } : {}),
          ...(Array.isArray(allowedControlIds) ? { allowedControlIds } : {})
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-batshit-service-token': serviceToken,
            'x-batshit-user-id': userId
          },
          timeout: 30000
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.response?.data?.error ?? error.message ?? 'Control find failed.'
            }, null, 2)
          }
        ]
      };
    }
  }

  /**
   * Control Registry Use
   * Execute a control by controlId.
   */
  async handleControlUse(args) {
    let effectiveControlId = '';
    try {
      const payload = (args && typeof args === 'object' && args.value && typeof args.value === 'object')
        ? args.value
        : (args || {});

      const {
        userId,
        agentId,
        sessionId,
        session_id,
        controlId,
        control_id,
        id,
        input,
        params,
        dryRun,
        dry_run,
        allowRisky,
        allow_risky,
        ...extraArgs
      } = payload;

      effectiveControlId = controlId || control_id || id || '';

      if (!userId) {
        throw new Error('userId is required for control use');
      }
      if (!effectiveControlId) {
        throw new Error('controlId is required for control use');
      }

      const effectiveInput =
        (input && typeof input === 'object' && !Array.isArray(input))
          ? input
          : (params && typeof params === 'object' && !Array.isArray(params))
            ? params
            : (Object.keys(extraArgs).length > 0 ? extraArgs : {});

      const batshitUrl = process.env.BATSHIT_FRONTEND_URL || 'http://localhost:5620';
      const serviceToken = this.resolveBatshitServiceToken();
      if (!serviceToken) {
        throw new Error('BATSHIT_TOKEN not configured - required for Fabric Registry');
      }

      const response = await axios.post(
        `${batshitUrl}/api/controls/use`,
        {
          userId,
          ...(agentId ? { agentId } : {}),
          ...((sessionId || session_id) ? { sessionId: sessionId || session_id } : {}),
          controlId: effectiveControlId,
          input: effectiveInput,
          dryRun: dryRun === true || dry_run === true,
          allowRisky: allowRisky === true || allow_risky === true
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-batshit-service-token': serviceToken,
            'x-batshit-user-id': userId
          },
          timeout: 60000
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              controlId: effectiveControlId || 'unknown',
              error: error.response?.data?.error ?? error.message ?? 'Control execution failed.'
            }, null, 2)
          }
        ]
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Batshit-Server MCP Server started');
  }
}

// Run the server
const server = new BatshitMcpServer();
server.run().catch((error) => {
  logger.error('Failed to start MCP server:', error);
  process.exit(1);
});
