/**
 * BL-5 — managed CLI helper steps for ANY helper server name.
 *
 * Profiles register the helper bridge as `CLI_HELPER_MCP_SERVER_NAME` (`batshit_helpers`) now,
 * and chats stored before BL-5 carry a per-agent name such as `batshit_gateway_cody-mode4-controls`.
 * Both must normalize, zip, and render the same, so each builder takes the server name.
 *
 * The shapes are the live captures already pinned elsewhere, unchanged apart from the server:
 * the Codex MCP wrappers (`{ arguments }` in, `{ content: [{ type: 'text', text }], structured_content,
 * input }` out) from `coolToolZipAdapter.test.ts` and `toolActivityContract.test.ts`, the mapped
 * read from `toolActivityContract.test.ts`, and the zip fetches from `zip-fetch-steps.ts`.
 */
import type { ToolOperationKind } from '$lib/utils/toolActivityContract'
import { claudeDirectZipFetchStep, codexDirectZipFetchStep } from './zip-fetch-steps'

/** The per-agent helper server name the captures carried before BL-5. */
export const LEGACY_CLI_HELPER_SERVER = 'batshit_gateway_cody-mode4-controls'

export type CliHelperStepCase = {
  label: string
  expectedKind: ToolOperationKind
  build: (server: string) => Record<string, any>
}

const mcpWrapper = (args: Record<string, any>, text: unknown) => ({
  content: [{ type: 'text', text }],
  structured_content: null,
  input: { arguments: args }
})

export const CLI_HELPER_STEP_CASES: CliHelperStepCase[] = [
  {
    label: 'native_skill invoke (Codex wrapper)',
    expectedKind: 'skill_read',
    build: (server) => {
      const args = { skillId: 'agent_browser', action: 'invoke', maxChars: 12000 }
      return {
        toolName: `mcp.${server}.native_skill`,
        originalToolName: `mcp.${server}.native_skill`,
        toolArgs: { arguments: args },
        toolResult: mcpWrapper(args, {
          auth: 'agent',
          userId: 'josh',
          success: true,
          action: 'invoke',
          skill: { summary: 'Object', truncated: true },
          skillMarkdown: '# agent-browser\n\nBrowser automation CLI for AI agents.'
        }),
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: server
      }
    }
  },
  {
    label: 'batshit_tool_search (Codex wrapper)',
    expectedKind: 'tool_find',
    build: (server) => {
      const args = { family: 'fabric', query: 'skill save', limit: 5 }
      return {
        toolName: `mcp.${server}.batshit_tool_search`,
        originalToolName: `mcp.${server}.batshit_tool_search`,
        toolArgs: { arguments: args },
        toolResult: mcpWrapper(args, {
          results: [
            {
              ref: 'fabric:sys.skill.save',
              family: 'fabric',
              title: 'Save Skill',
              description: 'Create or update a custom skill.',
              riskLevel: 'safe'
            }
          ],
          totalMatches: 1,
          query: 'skill save',
          families: ['fabric'],
          operationKind: 'tool_find',
          rendererFamily: 'tool_find'
        }),
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: server
      }
    }
  },
  {
    label: 'batshit_tool_use of a Fabric control (Codex wrapper)',
    expectedKind: 'fabric_use',
    build: (server) => {
      const args = { ref: 'fabric:sys.cli_tool.list', input: { includeArchived: false } }
      return {
        toolName: `mcp.${server}.batshit_tool_use`,
        originalToolName: `mcp.${server}.batshit_tool_use`,
        toolArgs: { arguments: args },
        toolResult: mcpWrapper(args, {
          auth: 'agent',
          userId: 'josh',
          success: true,
          controlId: 'sys.cli_tool.list',
          result: { summary: 'Object', truncated: true },
          ref: 'fabric:sys.cli_tool.list',
          family: 'fabric',
          target: 'sys.cli_tool.list',
          operationKind: 'fabric_use',
          rendererFamily: 'generic_tool'
        }),
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: server
      }
    }
  },
  {
    label: 'batshit_server_bash_execute (Codex wrapper)',
    expectedKind: 'bash',
    build: (server) => {
      const args = { command: 'pwd' }
      return {
        toolName: `mcp.${server}.batshit_server_bash_execute`,
        originalToolName: `mcp.${server}.batshit_server_bash_execute`,
        toolArgs: { arguments: args },
        toolResult: mcpWrapper(
          args,
          JSON.stringify({
            command: 'pwd',
            stdout: '/Users/example/hello\n',
            stderr: '',
            exitCode: 0,
            success: true,
            tool: 'bash_execute',
            action: 'bash_execute',
            backend: 'local'
          })
        ),
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: server
      }
    }
  },
  {
    label: 'batshit_server_bash_execute mapped to a read',
    expectedKind: 'read_file',
    build: (server) => ({
      toolName: `mcp.${server}.batshit_server_bash_execute`,
      originalToolName: `mcp.${server}.batshit_server_bash_execute`,
      toolArgs: { command: 'cat docs/example.md' },
      toolResult: {
        success: true,
        command: 'cat docs/example.md',
        stdout: '# Example\n\nHello.',
        stderr: '',
        exitCode: 0,
        mappedToolName: 'batshit_server_read_file',
        mappedToolInput: {
          command: 'cat docs/example.md',
          path: 'docs/example.md',
          filePath: 'docs/example.md'
        }
      },
      toolProvider: 'mcp',
      toolSource: 'mcp-gateway',
      mcpServerName: server
    })
  },
  {
    label: 'batshit_server_fetch_zip (Codex capture)',
    expectedKind: 'fetch_zip',
    build: (server) => codexDirectZipFetchStep(server)
  },
  {
    label: 'batshit_server_fetch_zip (Claude capture)',
    expectedKind: 'fetch_zip',
    build: (server) => claudeDirectZipFetchStep(server)
  }
]

/** Rewrite every mention of one server name to another, anywhere in a JSON-shaped value. */
export function renameHelperServer<T>(value: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(value).split(from).join(to)) as T
}
