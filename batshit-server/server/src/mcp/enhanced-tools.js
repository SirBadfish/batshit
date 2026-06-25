// Enhanced MCP Tool Descriptions - Self-documenting for n8n usage
// Each description contains full usage instructions, eliminating need for separate MCP system prompt

// Helper function to ensure proper schema formatting for n8n MCP Client
function formatToolSchema(tool) {
  // Ensure inputSchema has type: 'object' at minimum
  if (tool.inputSchema && !tool.inputSchema.type) {
    tool.inputSchema.type = 'object';
  }

  // If no inputSchema exists, create a minimal one
  if (!tool.inputSchema) {
    tool.inputSchema = {
      type: 'object',
      properties: {},
      required: []
    };
  }

  // Also add a parameters field for compatibility
  if (!tool.parameters) {
    tool.parameters = tool.inputSchema;
  }

  return tool;
}

const rawBuiltInTools = [
  // RETAINED NON-ARTIFACT TOOLS (temporary until Sandbox story closeout)
  {
    name: 'batshit_server_fetch_zip',
    description: 'batshit-server: Fetch a zip payload from Redis by zipId so the agent can peek at zipped content without unzipping it in chat. Params: zipId (required), maxChars (optional; default 4000, set 0 for full content). Returns content (possibly truncated) plus metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        zipId: { type: 'string', description: 'Zip ID to fetch (required)' },
        maxChars: { type: 'number', description: 'Max characters to return (0 = full)', default: 4000 }
      },
      required: ['zipId']
    }
  },

  // DYNAMIC MCP TOOLS (SA-009)
  // These tools allow agents to discover and execute any MCP tool on-demand,
  // without needing all tools enabled upfront (massive token savings)
  {
    name: 'batshit_server_dynamic_mcp_find',
    description: `Search for MCP tools across all configured gateways using tool names, descriptions, and MCP Group names.

PURPOSE: Discover tools (and their schemas) before executing them with batshit_server_dynamic_mcp_use.

RETURNS: Array of matching tools with:
- toolName: Exact name for batshit_server_dynamic_mcp_use
- description: What the tool does
- groupName: MCP Group name (from Settings)
- schemaHint: Compact schema summary (default)
- inputSchema: Full schema (only when schema="full")

SEARCH TIPS:
- Use broad terms: database, search, file, redis, postgres
- Use MCP Group names from the DCM list to narrow results
- Pass agentId from the DCM (agent_id) to exclude tools already enabled for this agent
- If you already know the tool name, pass tool to get schema directly (no search)
- Default limit = 5, schema = compact, includeEnabled = false

WORKFLOW: find → read schemaHint/inputSchema → use`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context (check webhook data for user_id)' },
        agentId: { type: 'string', description: 'Optional agent ID to exclude tools already enabled for this agent' },
        selectedGateways: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit gateway scope override (usually leave unset).'
        },
        query: { type: 'string', description: 'Search term (optional if tool or group is provided)' },
        tool: { type: 'string', description: 'Exact tool name to fetch details for (skips search)' },
        toolName: { type: 'string', description: 'Alias for tool' },
        group: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'MCP Group name(s) to filter results (from DCM list)'
        },
        mcpGroup: { type: 'string', description: 'Alias for group' },
        exact: { type: 'boolean', description: 'If true, only exact tool name matches for query' },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
        schema: { type: 'string', enum: ['compact', 'full', 'none'], description: 'Schema detail level (default compact)' },
        includeEnabled: { type: 'boolean', description: 'Include tools already enabled for this agent (default false)' }
      },
      required: ['userId']
    }
  },
  {
    name: 'batshit_server_dynamic_mcp_use',
    description: `Execute any MCP tool by name, even if not enabled for this agent.

WORKFLOW:
1. First call batshit_server_dynamic_mcp_find to discover tools and get their inputSchema
2. Build your params object based on the inputSchema from find results
3. Call this tool with the exact toolName and your params

TIP: If the DCM list already shows a schema hint you can call this tool directly. If you need full schema details, call batshit_server_dynamic_mcp_find with tool + schema="full".

CRITICAL - PARAMS STRUCTURE:
Tool arguments MUST go inside the params object. Do NOT put them at the top level.

CORRECT:
{ userId: josh, toolName: tavily-search, params: { query: latest AI news, max_results: 5 } }

WRONG (will fail):
{ userId: josh, toolName: tavily-search, query: latest AI news, max_results: 5 }

The params object contains whatever fields the target tool expects - check the inputSchema from find results.`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context' },
        agentId: { type: 'string', description: 'Optional agent ID for agent-scoped Dynamic MCP execution' },
        selectedGateways: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit gateway scope override (usually leave unset).'
        },
        toolName: { type: 'string', description: 'Exact tool name from batshit_server_dynamic_mcp_find results (e.g., tavily-search, Redis_get, firecrawl_scrape)' },
        tool: { type: 'string', description: 'Alias for toolName' },
        tool_name: { type: 'string', description: 'Alias for toolName' },
        params: { type: 'object', description: 'Tool arguments as key-value pairs. Check the inputSchema from find results for required/optional fields. This object is passed directly to the target tool.', additionalProperties: true }
      },
      required: ['userId'],
      anyOf: [
        { required: ['toolName'] },
        { required: ['tool'] },
        { required: ['tool_name'] }
      ],
      additionalProperties: true
    }
  },
  {
    name: 'mcp_artifact_find',
    description: `Find published artifact runtime capabilities by query.

PURPOSE: Discover runtime artifact invoke controls (for example use.artifact.{slug}) before executing with mcp_artifact_use.

RETURNS: matching published artifact runtime controls with title/description/risk/status/tags and optional inputSchema.`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context (required)' },
        query: { type: 'string', description: 'Search query for artifact runtime controls' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters (all must match)' },
        includeSchema: { type: 'boolean', description: 'Include full inputSchema objects in results' },
        includeDraft: { type: 'boolean', description: 'Include draft controls (default false)' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' }
      },
      required: ['userId']
    }
  },
  {
    name: 'mcp_artifact_use',
    description: `Execute a published artifact runtime capability by controlId.

WORKFLOW:
1. Use mcp_artifact_find to discover runtime artifact control IDs and schema
2. Build input payload matching schema
3. Call this tool with controlId + input`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context (required)' },
        controlId: { type: 'string', description: 'Exact runtime artifact control id from mcp_artifact_find (required)' },
        input: { type: 'object', description: 'Artifact runtime input payload (schema depends on artifact)', additionalProperties: true },
        dryRun: { type: 'boolean', description: 'Validate input without executing control', default: false },
        allowRisky: { type: 'boolean', description: 'Allow confirm/restricted controls to execute', default: false }
      },
      required: ['userId', 'controlId']
    }
  },
  {
    name: 'mcp_fabric_find',
    description: `Find Fabric Registry capabilities by query/tags/source/risk.

PURPOSE: Discover stable Batshit control IDs before executing with mcp_fabric_use.

RETURNS: matching controls with title/description/risk/status/tags and optional inputSchema.

WORKFLOW: find -> review schemaHint/inputSchema -> use`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context (required)' },
        query: { type: 'string', description: 'Search query for control id/title/description/tags' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters (all must match)' },
        sourceType: {
          anyOf: [
            { type: 'string', enum: ['core', 'artifact', 'workflow', 'plugin'] },
            { type: 'array', items: { type: 'string', enum: ['core', 'artifact', 'workflow', 'plugin'] } }
          ],
          description: 'Filter by control source type(s)'
        },
        riskLevel: {
          anyOf: [
            { type: 'string', enum: ['safe', 'confirm', 'restricted'] },
            { type: 'array', items: { type: 'string', enum: ['safe', 'confirm', 'restricted'] } }
          ],
          description: 'Filter by control risk level(s)'
        },
        includeSchema: { type: 'boolean', description: 'Include full inputSchema objects in results' },
        includeDraft: { type: 'boolean', description: 'Include draft controls (default false)' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' }
      },
      required: ['userId']
    }
  },
  {
    name: 'mcp_fabric_use',
    description: `Execute a Fabric Registry capability by controlId.

WORKFLOW:
1. Use mcp_fabric_find to discover control IDs and schema
2. Build input payload matching schema
3. Call this tool with controlId + input

RISK GATE:
- safe controls execute immediately
- confirm/restricted controls require allowRisky=true`,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user ID from your session context (required)' },
        controlId: { type: 'string', description: 'Exact control id from mcp_fabric_find (required)' },
        input: { type: 'object', description: 'Control input payload (schema depends on control)', additionalProperties: true },
        dryRun: { type: 'boolean', description: 'Validate input without executing control', default: false },
        allowRisky: { type: 'boolean', description: 'Allow confirm/restricted controls to execute', default: false }
      },
      required: ['userId', 'controlId']
    }
  }
];

// Apply formatting to ensure proper schema structure
const enhancedBuiltInTools = rawBuiltInTools.map(formatToolSchema);

module.exports = {
  enhancedBuiltInTools
};
