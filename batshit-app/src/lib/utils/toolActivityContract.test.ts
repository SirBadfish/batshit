import { describe, expect, it } from 'vitest'
import {
  isBinaryLikeText,
  normalizeCompactTool,
  resolveToolActivitySettingsName,
  shouldForceCompressToolPayload
} from './toolActivityContract'

describe('toolActivityContract', () => {
  it('normalizes native skill reads into the skill_read lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_skill',
      toolArgs: {
        action: 'read',
        skillId: 'agent-browser',
        path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md'
      },
      toolResult: {
        action: 'read',
        skillId: 'agent-browser',
        skillName: 'Agent Browser',
        path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md',
        content: '# Agent Browser\n\nUse the browser.'
      }
    })

    expect(result.operationKind).toBe('skill_read')
    expect(result.rendererFamily).toBe('skill_read')
    expect(result.toolArgs.skillId).toBe('agent-browser')
    expect(result.toolResult.skillName).toBe('Agent Browser')
  })

  it('normalizes Mode 4 helper native_skill invoke results into the skill_read lane', () => {
    const result = normalizeCompactTool({
      toolName: 'mcp.agent-123-mode4-controls.native_skill',
      toolArgs: {
        action: 'invoke',
        skillId: 'agent-browser'
      },
      toolResult: {
        action: 'invoke',
        skill: {
          id: 'agent-browser',
          name: 'Agent Browser'
        },
        skillMarkdown: '# Agent Browser\n\nUse the browser.'
      }
    })

    expect(result.operationKind).toBe('skill_read')
    expect(result.rendererFamily).toBe('skill_read')
    expect(result.toolArgs.action).toBe('invoke')
    expect(result.toolArgs.path).toBe('SKILL.md')
    expect(result.toolResult.action).toBe('invoke')
    expect(result.toolResult.skillName).toBe('Agent Browser')
    expect(result.toolResult.content).toContain('Agent Browser')
  })

  it('normalizes live Mode 4 helper MCP skill invoke wrappers into the skill_read lane', () => {
    const result = normalizeCompactTool({
      toolName: 'mcp.batshit_gateway_cody-mode4-controls.native_skill',
      toolArgs: {
        arguments: {
          skillId: 'agent_browser',
          action: 'invoke',
          maxChars: 12000
        }
      },
      toolResult: {
        content: [
          {
            type: 'text',
            text: {
              auth: 'service',
              userId: 'josh',
              success: true,
              action: 'invoke',
              skill: {
                summary: 'Object',
                truncated: true
              },
              skillMarkdown: '# agent-browser\n\nBrowser automation CLI for AI agents.'
            }
          }
        ],
        structured_content: null,
        input: {
          arguments: {
            skillId: 'agent_browser',
            action: 'invoke',
            maxChars: 12000
          }
        },
        action: 'invoke'
      }
    })

    expect(result.operationKind).toBe('skill_read')
    expect(result.rendererFamily).toBe('skill_read')
    expect(result.toolArgs.action).toBe('invoke')
    expect(result.toolArgs.skillId).toBe('agent_browser')
    expect(result.toolArgs.path).toBe('SKILL.md')
    expect(result.toolResult.action).toBe('invoke')
    expect(result.toolResult.content).toContain('Browser automation CLI')
  })

  it('compacts web search results into the dedicated web_search family', () => {
    const result = normalizeCompactTool({
      toolName: 'native_web_search',
      toolArgs: {
        query: 'batshit app'
      },
      toolResult: {
        query: 'batshit app',
        provider: 'exa',
        results: [
          {
            title: 'Batshit',
            url: 'https://batshit.ai',
            snippet: 'Batshit is an AI workspace.'
          }
        ]
      }
    })

    expect(result.operationKind).toBe('web_search')
    expect(result.rendererFamily).toBe('web_search')
    expect(result.toolResult.provider).toBe('exa')
    expect(result.toolResult.results[0].title).toBe('Batshit')
  })

  it('normalizes brokered fabric Fetch Zip into the fetch_zip lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.zip.fetch',
        input: {
          zipId: 'zip_demo',
          includeContent: true,
          maxChars: 16000
        }
      },
      toolResult: {
        success: true,
        family: 'fabric',
        target: 'sys.zip.fetch',
        ref: 'fabric:sys.zip.fetch',
        operationKind: 'fetch_zip',
        rendererFamily: 'generic_tool',
        result: {
          found: true,
          zipId: 'zip_demo',
          type: 'tool',
          description: 'Demo zip',
          content: 'zip content',
          contentLength: 11,
          contentTruncated: false
        }
      }
    })

    expect(result.operationKind).toBe('fetch_zip')
    expect(result.rendererFamily).toBe('generic_tool')
    expect(result.toolArgs).toEqual({
      zipId: 'zip_demo',
      includeContent: true,
      maxChars: 16000
    })
    expect(result.toolResult).toMatchObject({
      found: true,
      zipId: 'zip_demo',
      content: 'zip content'
    })
  })

  it('normalizes legacy Batshit Native Tools web search envelopes into the web_search family', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'web_search'
      },
      toolResult: [
        {
          success: true,
          action: 'web_search',
          data: {
            query: 'Svelte 5 runes',
            provider: 'perplexity',
            results: [
              {
                title: 'Svelte 5',
                url: 'https://svelte.dev/docs/svelte/what-are-runes',
                snippet: 'Runes are compiler keywords.'
              }
            ]
          }
        }
      ]
    })

    expect(result.operationKind).toBe('web_search')
    expect(result.rendererFamily).toBe('web_search')
    expect(result.toolArgs.query).toBe('Svelte 5 runes')
    expect(result.toolResult.query).toBe('Svelte 5 runes')
    expect(result.toolResult.provider).toBe('perplexity')
    expect(result.toolResult.results[0].title).toBe('Svelte 5')
  })

  it('normalizes live Batshit Tools web search envelopes into the web_search family', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Tools',
      toolArgs: {
        action: 'web_search'
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'web_search',
          backend: 'local',
          context: {
            mode: 'mode2',
            actor_type: 'primary',
            agent_id: 'sample_n8n_primary'
          },
          data: {
            query: 'Docker n8n web search',
            provider: 'exa',
            results: [
              {
                title: 'Docker',
                url: 'https://docs.docker.com/',
                snippet: 'Docker documentation.'
              }
            ]
          }
        }
      ]
    })

    expect(result.operationKind).toBe('web_search')
    expect(result.rendererFamily).toBe('web_search')
    expect(result.toolArgs.query).toBe('Docker n8n web search')
    expect(result.toolResult.provider).toBe('exa')
    expect(result.toolResult.results[0].title).toBe('Docker')
  })

  it('normalizes live Batshit Tools fetch_zip envelopes into the fetch_zip lane', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Tools',
      toolArgs: {
        action: 'fetch_zip'
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'fetch_zip',
          backend: 'local',
          data: {
            found: true,
            zipId: 'cool_tool_123',
            content: '{"hello":"world"}'
          }
        }
      ]
    })

    expect(result.operationKind).toBe('fetch_zip')
    expect(result.rendererFamily).toBe('generic_tool')
  })

  it('resolves native-pack dynamic MCP use to the executed MCP tool name for zip settings', () => {
    const input = {
      toolName: 'Batshit_Tools',
      toolArgs: {
        action: 'dynamic_mcp_use',
        input: {
          toolName: 'mcp_huggingface_search_models',
          params: {
            query: 'text to image'
          }
        }
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'dynamic_mcp_use',
          backend: 'local',
          data: {
            success: true,
            toolName: 'mcp_huggingface_search_models',
            requestedToolName: 'huggingface search',
            result: {
              models: []
            },
            executionTimeMs: 37
          }
        }
      ]
    }
    const normalized = normalizeCompactTool(input)

    expect(normalized.operationKind).toBe('dynamic_use')
    expect(normalized.rendererFamily).toBe('generic_tool')
    expect(resolveToolActivitySettingsName(input, normalized.operationKind)).toBe(
      'mcp_huggingface_search_models'
    )
    expect(normalized.toolArgs.toolName).toBe('mcp_huggingface_search_models')
  })

  it('resolves native-pack CLI tool use to the executed CLI tool id for zip settings', () => {
    const input = {
      toolName: 'Batshit_Tools',
      toolArgs: {
        action: 'cli_tool_use',
        input: {
          toolId: 'repo_snapshot',
          input: {
            path: '/workspace'
          }
        }
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'cli_tool_use',
          backend: 'local',
          data: {
            success: true,
            toolId: 'repo_snapshot',
            stdout: 'clean',
            stderr: '',
            exitCode: 0
          }
        }
      ]
    }
    const normalized = normalizeCompactTool(input)

    expect(normalized.operationKind).toBe('cli_tool')
    expect(normalized.rendererFamily).toBe('cli_tool')
    expect(resolveToolActivitySettingsName(input, normalized.operationKind)).toBe('repo_snapshot')
    expect(normalized.toolArgs.toolId).toBe('repo_snapshot')
  })

  it('normalizes legacy Batshit Native Tools native_skill invoke envelopes into the skill_read family', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'native_skill'
      },
      toolResult: [
        {
          success: true,
          action: 'native_skill',
          data: {
            success: true,
            action: 'invoke',
            skill: {
              id: 'agent_browser',
              name: 'agent-browser'
            },
            skillMarkdown: '# agent-browser\n\nBrowser automation CLI for AI agents.'
          }
        }
      ]
    })

    expect(result.operationKind).toBe('skill_read')
    expect(result.rendererFamily).toBe('skill_read')
    expect(result.toolArgs.action).toBe('invoke')
    expect(result.toolArgs.path).toBe('SKILL.md')
    expect(result.toolResult.action).toBe('invoke')
    expect(result.toolResult.skillName).toBe('agent-browser')
    expect(result.toolResult.content).toContain('Browser automation CLI')
  })

  it('normalizes legacy Batshit Native Tools bash envelopes into the bash family', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'bash_execute'
      },
      toolResult: [
        {
          success: true,
          action: 'bash_execute',
          data: {
            command: 'pwd',
            stdout: '/Users/example/hello',
            stderr: '',
            exitCode: 0
          }
        }
      ]
    })

    expect(result.operationKind).toBe('bash')
    expect(result.rendererFamily).toBe('bash')
    expect(result.toolArgs.command).toBe('pwd')
    expect(result.toolResult.command).toBe('pwd')
    expect(result.toolResult.stdout).toContain('/Users/example/hello')
    expect(result.toolResult.exitCode).toBe(0)
  })

  it('normalizes Mode 4 bash helper mapped read output into the read_file lane', () => {
    const result = normalizeCompactTool({
      toolName: 'mcp.agent-123-mode4-controls.batshit_server_bash_execute',
      toolArgs: {
        command: 'cat docs/example.md'
      },
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
      }
    })

    expect(result.operationKind).toBe('read_file')
    expect(result.rendererFamily).toBe('read_file')
    expect(result.toolArgs.filePath).toBe('docs/example.md')
    expect(result.toolResult.content).toContain('Hello.')
  })

  it('normalizes legacy Batshit Native Tools edit envelopes into the edit_file family with a real diff preview', () => {
    const patch =
      "apply_patch<<'PATCH'\n" +
      '*** Begin Patch\n' +
      '*** Update File: /Users/example/hello/sa049-mode2-write.txt\n' +
      '@@\n' +
      ' alpha\n' +
      '-beta\n' +
      '+BRAVO\n' +
      ' gamma\n' +
      '*** End Patch\n' +
      'PATCH'

    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'bash_execute'
      },
      toolResult: [
        {
          success: true,
          action: 'bash_execute',
          data: {
            success: true,
            command: patch,
            mappedToolName: 'batshit_server_edit_file',
            mappedToolInput: {
              command: patch,
              innerCommand: patch,
              filePath: 'sa049-mode2-write.txt',
              path: 'sa049-mode2-write.txt'
            }
          }
        }
      ]
    })

    expect(result.operationKind).toBe('edit_file')
    expect(result.rendererFamily).toBe('edit_file')
    expect(result.toolResult.filePath).toBe('sa049-mode2-write.txt')
    expect(result.toolResult.diff).toContain('*** Begin Patch')
    expect(result.toolResult.diff).toContain('+BRAVO')
  })

  it('normalizes native edit envelopes with before/after snapshots into a compact diff preview', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'bash_execute'
      },
      toolResult: [
        {
          success: true,
          action: 'bash_execute',
          data: {
            success: true,
            mappedToolName: 'batshit_server_edit_file',
            mappedToolInput: {
              filePath: '/Users/example/hello/demo.txt',
              path: '/Users/example/hello/demo.txt'
            },
            before: 'alpha\nbeta\ngamma\n',
            after: 'alpha\nbravo\ngamma\n'
          }
        }
      ]
    })

    expect(result.operationKind).toBe('edit_file')
    expect(result.rendererFamily).toBe('edit_file')
    expect(result.toolResult.filePath).toBe('/Users/example/hello/demo.txt')
    expect(result.toolResult.diff).toContain('--- Before')
    expect(result.toolResult.diff).toContain('-   2 | beta')
    expect(result.toolResult.diff).toContain('+   2 | bravo')
  })

  it('normalizes command-only native write envelopes into the write_file family with truthful counts', () => {
    const command =
      'mkdir -p /Users/example/hello && printf "alpha\\nbeta\\ngamma\\n" > /Users/example/hello/sa049-mode1-write.txt'

    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'bash_execute'
      },
      toolResult: [
        {
          success: true,
          action: 'bash_execute',
          data: {
            success: true,
            command,
            mappedToolName: 'batshit_server_overwrite_file',
            mappedToolInput: {
              command,
              innerCommand: command,
              filePath: '/Users/example/hello/sa049-mode1-write.txt',
              path: '/Users/example/hello/sa049-mode1-write.txt'
            }
          }
        }
      ]
    })

    expect(result.operationKind).toBe('write_file')
    expect(result.rendererFamily).toBe('write_file')
    expect(result.toolResult.filePath).toBe('/Users/example/hello/sa049-mode1-write.txt')
    expect(result.toolResult.content).toBe('alpha\nbeta\ngamma')
    expect(result.toolResult.lineCount).toBe(3)
    expect(result.toolResult.size).toBe(17)
  })

  it('honors mapped list_files metadata inside legacy Batshit Native Tools bash envelopes', () => {
    const result = normalizeCompactTool({
      toolName: 'Batshit_Native_Tools',
      toolArgs: {
        action: 'bash_execute',
        input: {
          cmd: 'ls -la /Users/example/hello'
        }
      },
      toolResult: [
        {
          success: true,
          action: 'bash_execute',
          data: {
            command:
              'docker sandbox exec --workdir /Users/example/hello batshit-josh-49fef393f0 /bin/bash -lc ls -la /Users/example/hello',
            stdout: [
              'total 16',
              'drwxr-xr-x 5 root  root   160 Mar  9 22:46 .',
              'drwxr-xr-x 3 root  root  4096 Mar 12 00:10 ..',
              '-rw-r--r-- 1 agent agent 6148 Mar  9 22:46 .DS_Store',
              'drwxr-xr-x 5 agent agent  160 Mar  9 22:46 artifacts',
              '-rw-r--r-- 1 agent agent  817 Mar  9 23:02 hello.md'
            ].join('\n'),
            stderr: '',
            exitCode: 0,
            mappedToolName: 'batshit_server_list_files',
            mappedToolInput: {
              command: 'ls -la /Users/example/hello',
              innerCommand: 'ls -la /Users/example/hello',
              path: '/Users/example/hello',
              dirPath: '/Users/example/hello'
            }
          }
        }
      ]
    })

    expect(result.operationKind).toBe('list_files')
    expect(result.rendererFamily).toBe('list_files')
    expect(result.toolArgs.path).toBe('/Users/example/hello')
    expect(result.toolArgs.dirPath).toBe('/Users/example/hello')
    expect(result.toolArgs.innerCommand).toBe('ls -la /Users/example/hello')
    expect(result.toolResult.totalItems).toBe(3)
    expect(result.toolResult.files).toEqual([
      expect.objectContaining({
        path: '.DS_Store',
        type: 'file'
      }),
      expect.objectContaining({
        path: 'artifacts',
        type: 'directory'
      }),
      expect.objectContaining({
        path: 'hello.md',
        type: 'file'
      })
    ])
  })

  it('normalizes Claude built-in web search aliases into the web_search family', () => {
    const result = normalizeCompactTool({
      toolName: 'claude_web_search',
      toolArgs: {
        query: 'Batshit AI'
      },
      toolResult: {
        results: [
          {
            title: 'Batshit',
            url: 'https://batshit.ai'
          }
        ]
      }
    })

    expect(result.operationKind).toBe('web_search')
    expect(result.rendererFamily).toBe('web_search')
  })

  it('parses text-only search_files output into truthful match metadata', () => {
    const result = normalizeCompactTool({
      toolName: 'batshit_server_search_files',
      toolArgs: {
        command: 'rg "zipActivation" batshit-app/src/lib',
        innerCommand: 'rg "zipActivation" batshit-app/src/lib'
      },
      toolResult: {
        output: [
          'batshit-app/src/lib/utils/zipActivation.ts:84:const resolvedToolName = ...',
          'batshit-app/src/lib/services/messageCompiler.ts:17:import { zipActivation } from "./zipActivation"'
        ].join('\n')
      }
    })

    expect(result.operationKind).toBe('search_files')
    expect(result.rendererFamily).toBe('bash')
    expect(result.toolResult.query).toBe('zipActivation')
    expect(result.toolResult.totalMatches).toBe(2)
    expect(result.toolResult.totalMatchingFiles).toBe(2)
    expect(result.toolResult.results).toEqual([
      expect.objectContaining({
        path: 'batshit-app/src/lib/utils/zipActivation.ts',
        matchCount: 1
      }),
      expect.objectContaining({
        path: 'batshit-app/src/lib/services/messageCompiler.ts',
        matchCount: 1
      })
    ])
  })

  it('parses files-only search output without misreading hyphenated filenames as line numbers', () => {
    const result = normalizeCompactTool({
      toolName: 'batshit_server_search_files',
      toolArgs: {
        command: 'rg -n -l "zipActivation" /Users/example/batshit',
        innerCommand: 'rg -n -l "zipActivation" /Users/example/batshit'
      },
      toolResult: {
        stdout: [
          '/Users/example/batshit/batshit-app/src/lib/services/messageCompiler.ts',
          '/Users/example/batshit/docs/user-docs/tools/zips.md',
          '/Users/example/batshit/batshit-app/src/lib/utils/zipActivation.test.ts'
        ].join('\n')
      }
    })

    expect(result.operationKind).toBe('search_files')
    expect(result.rendererFamily).toBe('bash')
    expect(result.toolResult.query).toBe('zipActivation')
    expect(result.toolResult.totalMatches).toBe(3)
    expect(result.toolResult.totalMatchingFiles).toBe(3)
    expect(result.toolResult.results).toEqual([
      expect.objectContaining({
        path: '/Users/example/batshit/batshit-app/src/lib/services/messageCompiler.ts',
        matchCount: 1,
        matches: []
      }),
      expect.objectContaining({
        path: '/Users/example/batshit/docs/user-docs/tools/zips.md',
        matchCount: 1,
        matches: []
      }),
      expect.objectContaining({
        path: '/Users/example/batshit/batshit-app/src/lib/utils/zipActivation.test.ts',
        matchCount: 1,
        matches: []
      })
    ])
  })

  it('parses combined short-flag grep files-only output into truthful counts', () => {
    const result = normalizeCompactTool({
      toolName: 'batshit_server_search_files',
      toolArgs: {
        command: 'grep -rl "\\bworkspace\\b" /Users/example/hello',
        innerCommand: 'grep -rl "\\bworkspace\\b" /Users/example/hello'
      },
      toolResult: {
        query: '\\bworkspace\\b',
        stdout: '/Users/example/hello/hello.md'
      }
    })

    expect(result.operationKind).toBe('search_files')
    expect(result.rendererFamily).toBe('bash')
    expect(result.toolResult.query).toBe('\\bworkspace\\b')
    expect(result.toolResult.totalMatches).toBe(1)
    expect(result.toolResult.totalMatchingFiles).toBe(1)
    expect(result.toolResult.results).toEqual([
      expect.objectContaining({
        path: '/Users/example/hello/hello.md',
        matchCount: 1,
        matches: []
      })
    ])
  })

  it('normalizes rg --files output into the list_files lane with structured file rows', () => {
    const result = normalizeCompactTool({
      toolName: 'batshit_server_list_files',
      toolArgs: {
        command: 'rg --files /Users/example/batshit/batshit-app/src/lib/components/chat',
        innerCommand: 'rg --files /Users/example/batshit/batshit-app/src/lib/components/chat',
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat',
        dirPath: '/Users/example/batshit/batshit-app/src/lib/components/chat'
      },
      toolResult: {
        stdout: [
          '/Users/example/batshit/batshit-app/src/lib/components/chat/ChatArea.svelte',
          '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivityGroup.svelte',
          '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivitySegment.svelte'
        ].join('\n')
      }
    })

    expect(result.operationKind).toBe('list_files')
    expect(result.rendererFamily).toBe('list_files')
    expect(result.toolArgs.path).toBe('/Users/example/batshit/batshit-app/src/lib/components/chat')
    expect(result.toolResult.totalFiles).toBe(3)
    expect(result.toolResult.totalDirectories).toBe(0)
    expect(result.toolResult.totalItems).toBe(3)
    expect(result.toolResult.files).toEqual([
      expect.objectContaining({
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ChatArea.svelte',
        name: 'ChatArea.svelte',
        type: 'file'
      }),
      expect.objectContaining({
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivityGroup.svelte',
        name: 'ToolActivityGroup.svelte',
        type: 'file'
      }),
      expect.objectContaining({
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivitySegment.svelte',
        name: 'ToolActivitySegment.svelte',
        type: 'file'
      })
    ])
  })

  it('preserves uncertainty for bare ls output that lacks directory markers', () => {
    const result = normalizeCompactTool({
      toolName: 'batshit_server_list_files',
      toolArgs: {
        command: 'ls /Users/example/hello',
        innerCommand: 'ls /Users/example/hello',
        path: '/Users/example/hello',
        dirPath: '/Users/example/hello',
        filePath: '/Users/example/hello'
      },
      toolResult: {
        stdout: ['artifacts', 'hello.md'].join('\n'),
        filePath: '/Users/example/hello',
        input: {
          command: 'ls /Users/example/hello',
          innerCommand: 'ls /Users/example/hello',
          path: '/Users/example/hello',
          dirPath: '/Users/example/hello',
          filePath: '/Users/example/hello'
        }
      }
    })

    expect(result.operationKind).toBe('list_files')
    expect(result.rendererFamily).toBe('list_files')
    expect(result.toolResult.totalFiles).toBe(0)
    expect(result.toolResult.totalDirectories).toBe(0)
    expect(result.toolResult.totalUnknownItems).toBe(2)
    expect(result.toolResult.totalItems).toBe(2)
    expect(result.toolResult.files).toEqual([
      expect.objectContaining({
        path: 'artifacts',
        name: 'artifacts',
        type: 'unknown'
      }),
      expect.objectContaining({
        path: 'hello.md',
        name: 'hello.md',
        type: 'unknown'
      })
    ])
  })

  it('omits binary-like file content from the main compact payload', () => {
    const binaryLikeContent = `data:image/png;base64,${'A'.repeat(1024)}`

    expect(isBinaryLikeText(binaryLikeContent)).toBe(true)

    const result = normalizeCompactTool({
      toolName: 'read_file',
      toolArgs: { path: '/tmp/image.txt' },
      toolResult: { content: binaryLikeContent }
    })

    expect(result.operationKind).toBe('read_file')
    expect(result.toolResult.contentOmitted).toBe(true)
    expect(result.flags.binaryLikeOmitted).toBe(true)
  })

  it('preserves JSON-looking read_file content as literal file text', () => {
    const packageJson = '{\n  "name": "batshit-v2",\n  "type": "module"\n}\n'

    const result = normalizeCompactTool({
      toolName: 'read_file',
      toolArgs: { path: 'package.json' },
      toolResult: {
        path: 'package.json',
        content: packageJson,
        language: 'json',
        lineCount: 5
      }
    })

    expect(result.operationKind).toBe('read_file')
    expect(result.rendererFamily).toBe('read_file')
    expect(result.toolResult.content).toBe(packageJson.trimEnd())
    expect(result.toolResult.contentChars).toBe(packageJson.length)
    expect(result.toolResult.contentTruncated).toBe(false)
    expect(result.flags.compacted).toBe(false)
  })

  it('forces compression when either raw or compact tokens exceed the hard ceiling', () => {
    expect(
      shouldForceCompressToolPayload({
        rawTokens: 10_000,
        compactTokens: 10
      })
    ).toBe(true)
    expect(
      shouldForceCompressToolPayload({
        rawTokens: 10,
        compactTokens: 10_000
      })
    ).toBe(true)
    expect(
      shouldForceCompressToolPayload({
        rawTokens: 9_999,
        compactTokens: 9_999
      })
    ).toBe(false)
  })

  it('normalizes CLI tool find helpers into the tool_find lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_cli_tool_find',
      toolArgs: {
        query: 'snapshot'
      },
      toolResult: {
        query: 'snapshot',
        totalMatches: 1,
        results: [
          {
            toolId: 'repo_snapshot',
            title: 'Repo Snapshot',
            description: 'Capture a repo snapshot.'
          }
        ]
      }
    })

    expect(result.operationKind).toBe('tool_find')
    expect(result.rendererFamily).toBe('tool_find')
    expect(result.toolResult.results[0].toolId).toBe('repo_snapshot')
  })

  it('normalizes Batshit tool search into the tool_find lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_search',
      toolArgs: {
        family: 'mcp',
        query: 'issues'
      },
      toolResult: {
        operationKind: 'tool_find',
        rendererFamily: 'tool_find',
        results: [
          {
            ref: 'mcp:github_search_issues',
            family: 'mcp',
            title: 'Search Issues'
          }
        ]
      }
    })

    expect(result.operationKind).toBe('tool_find')
    expect(result.rendererFamily).toBe('tool_find')
    expect(result.toolResult.results[0].ref).toBe('mcp:github_search_issues')
  })

  it('normalizes managed CLI broker search wrappers into the tool_find lane', () => {
    const result = normalizeCompactTool({
      toolName: 'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_search',
      toolArgs: {
        arguments: {
          family: 'fabric',
          query: 'skill save',
          limit: 5
        }
      },
      toolResult: {
        content: [
          {
            type: 'text',
            text: {
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
            }
          }
        ],
        structured_content: null,
        input: {
          arguments: {
            family: 'fabric',
            query: 'skill save',
            limit: 5
          }
        }
      }
    })

    expect(result.operationKind).toBe('tool_find')
    expect(result.rendererFamily).toBe('tool_find')
    expect(result.toolArgs).toMatchObject({
      family: 'fabric',
      query: 'skill save',
      limit: 5
    })
    expect(result.toolResult.totalMatches).toBe(1)
    expect(result.toolResult.results[0]).toMatchObject({
      ref: 'fabric:sys.skill.save',
      family: 'fabric',
      title: 'Save Skill'
    })
  })

  it('uses Batshit tool use operation metadata to preserve the executed family lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'cli:repo_snapshot',
        input: {
          path: '/workspace'
        }
      },
      toolResult: {
        success: true,
        ref: 'cli:repo_snapshot',
        family: 'cli',
        target: 'repo_snapshot',
        operationKind: 'cli_tool',
        rendererFamily: 'cli_tool',
        toolId: 'repo_snapshot'
      }
    })

    expect(result.operationKind).toBe('cli_tool')
    expect(result.rendererFamily).toBe('cli_tool')
    expect(result.toolArgs.toolId).toBe('repo_snapshot')
  })

  it('normalizes managed CLI broker use wrappers to the executed Fabric control', () => {
    const input = {
      toolName: 'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_use',
      toolArgs: {
        arguments: {
          ref: 'fabric:sys.cli_tool.list',
          input: {
            includeArchived: false
          }
        }
      },
      toolResult: {
        content: [
          {
            type: 'text',
            text: {
              auth: 'service',
              userId: 'josh',
              success: true,
              controlId: 'sys.cli_tool.list',
              result: {
                summary: 'Object',
                truncated: true
              },
              ref: 'fabric:sys.cli_tool.list',
              family: 'fabric',
              target: 'sys.cli_tool.list',
              operationKind: 'fabric_use',
              rendererFamily: 'generic_tool'
            }
          }
        ],
        structured_content: null,
        input: {
          arguments: {
            ref: 'fabric:sys.cli_tool.list',
            input: {
              includeArchived: false
            }
          }
        }
      }
    }
    const result = normalizeCompactTool(input)

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('generic_tool')
    expect(resolveToolActivitySettingsName(input, result.operationKind)).toBe('sys.cli_tool.list')
    expect(result.toolArgs).toMatchObject({
      ref: 'fabric:sys.cli_tool.list',
      target: 'sys.cli_tool.list',
      input: {
        includeArchived: false
      }
    })
    expect(result.toolResult).toMatchObject({
      controlId: 'sys.cli_tool.list',
      target: 'sys.cli_tool.list',
      operationKind: 'fabric_use'
    })
  })

  it('renders artifact create controls through the write-file renderer family', () => {
    const content = '<!doctype html>\n<html><body><h1>Nano Banana 2</h1></body></html>'
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.create',
        input: {
          name: 'Nano Banana 2',
          content
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.create',
        family: 'fabric',
        target: 'sys.artifact.create',
        artifact: {
          id: 'artifact_1',
          name: 'Nano Banana 2',
          contentChars: content.length
        }
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('write_file')
    expect(result.displayToolName).toBe('Artifact Create')
    expect(result.metadata?.rendererTitle).toBe('Artifact Create')
    expect(result.metadata?.artifactName).toBe('Nano Banana 2')
    expect(result.toolResult.filePath).toBe('artifact.html')
    expect(result.toolResult.language).toBe('html')
    expect(result.toolResult.content).toContain('Nano Banana 2')
  })

  it('renders artifact get controls through the read-file renderer family when content is returned', () => {
    const content = '<html><body><button>Generate</button></body></html>'
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.get',
        input: {
          artifactId: 'artifact_1'
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.get',
        family: 'fabric',
        target: 'sys.artifact.get',
        artifact: {
          id: 'artifact_1',
          name: 'Nano Banana 2',
          content,
          contentChars: content.length
        }
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('read_file')
    expect(result.displayToolName).toBe('Artifact Read')
    expect(result.metadata?.rendererTitle).toBe('Artifact Read')
    expect(result.toolArgs.filePath).toBe('artifact.html')
    expect(result.toolResult.content).toContain('Generate')
  })

  it('renders nested broker artifact get detail results through the read-file renderer family', () => {
    const content = '<!DOCTYPE html>\n<html><body><h1>Preview me</h1></body></html>'
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.get',
        input: {
          artifactId: 'artifact_1'
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.get',
        family: 'fabric',
        target: 'sys.artifact.get',
        result: {
          success: true,
          artifactView: 'detail',
          artifact: {
            id: 'artifact_1',
            name: 'Nano Banana 2',
            content,
            contentChars: content.length
          }
        }
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('read_file')
    expect(result.displayToolName).toBe('Artifact Read')
    expect(result.metadata?.artifactName).toBe('Nano Banana 2')
    expect(result.toolResult.filePath).toBe('artifact.html')
    expect(result.toolResult.language).toBe('html')
    expect(result.toolResult.content).toContain('Preview me')
  })

  it('renders artifact get summary preview objects through the read-file renderer family', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.get',
        input: {
          artifactId: 'artifact_1'
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.get',
        family: 'fabric',
        target: 'sys.artifact.get',
        result: {
          success: true,
          artifactView: 'detail',
          artifact: {
            id: 'artifact_1',
            name: 'Nano Banana 2',
            content: {
              preview: '<!DOCTYPE html>\n<html><body><h1>Summarized preview</h1></body></html>',
              truncated: true,
              approxChars: 12345
            }
          }
        }
      }
    })

    expect(result.rendererFamily).toBe('read_file')
    expect(result.toolResult.content).toContain('Summarized preview')
    expect(result.toolResult.contentTruncated).toBe(true)
    expect(result.flags.truncated).toBe(true)
  })

  it('renders nested artifact update diff results through the edit-file renderer family', () => {
    const diff = ['--- Before: artifact.html', '+++ After: artifact.html', '-old', '+new'].join('\n')
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.update',
        input: {
          artifactId: 'artifact_1',
          content: '<html><body>new</body></html>'
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.update',
        family: 'fabric',
        target: 'sys.artifact.update',
        result: {
          success: true,
          artifactView: 'summary',
          diff,
          artifact: {
            id: 'artifact_1',
            name: 'Nano Banana 2',
            contentChars: 29
          }
        }
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('edit_file')
    expect(result.displayToolName).toBe('Artifact Edit')
    expect(result.metadata?.artifactName).toBe('Nano Banana 2')
    expect(result.toolArgs.command).toBe(diff)
    expect(result.toolResult.diff).toContain('+new')
  })

  it('renders metadata-only artifact update results as compact settings changes', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.update',
        input: {
          artifactId: 'artifact_1',
          model_config: {
            mode: 'basic',
            primary: {
              source: 'manual',
              modelId: 'gemini-3.1-flash-image'
            }
          }
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.update',
        family: 'fabric',
        target: 'sys.artifact.update',
        result: {
          success: true,
          artifactView: 'summary',
          contentChanged: false,
          artifactUpdate: {
            kind: 'model_config',
            contentChanged: false,
            updatedFields: ['model_config'],
            message: 'Artifact model_config updated.'
          },
          artifact: {
            id: 'artifact_1',
            name: 'Nano Banana 2',
            slug: 'nano-banana-2',
            mode: 'published',
            zone: 'panel',
            version: 1,
            contentChars: 10177
          }
        }
      }
    })

    expect(result.rendererFamily).toBe('generic_tool')
    expect(result.displayToolName).toBe('Artifact Edit')
    expect(result.toolArgs).toEqual({
      artifactId: 'artifact_1',
      updatedFields: ['model_config']
    })
    expect(result.toolResult.update).toMatchObject({
      kind: 'model_config',
      updatedFields: ['model_config']
    })
    expect(result.toolResult.artifact).toMatchObject({
      name: 'Nano Banana 2',
      mode: 'published'
    })
  })

  it('renders artifact apply_patch controls through the edit-file renderer family', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: artifact.html',
      '@@',
      '-<h1>Old</h1>',
      '+<h1>New</h1>',
      '*** End Patch'
    ].join('\n')
    const result = normalizeCompactTool({
      toolName: 'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_use',
      toolArgs: {
        arguments: {
          ref: 'fabric:sys.artifact.apply_patch',
          input: {
            artifactId: 'artifact_1',
            patch
          }
        }
      },
      toolResult: {
        content: [
          {
            type: 'text',
            text: {
              success: true,
              ref: 'fabric:sys.artifact.apply_patch',
              family: 'fabric',
              target: 'sys.artifact.apply_patch',
              artifact: {
                id: 'artifact_1',
                name: 'Nano Banana 2'
              }
            }
          }
        ]
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('edit_file')
    expect(result.displayToolName).toBe('Artifact Edit')
    expect(result.metadata?.rendererTitle).toBe('Artifact Edit')
    expect(result.toolArgs.command).toContain('*** Begin Patch')
    expect(result.toolResult.diff).toContain('+<h1>New</h1>')
  })

  it('labels artifact run log controls without changing their generic renderer family', () => {
    const result = normalizeCompactTool({
      toolName: 'native_batshit_tool_use',
      toolArgs: {
        ref: 'fabric:sys.artifact.run_logs.get',
        input: {
          artifactId: 'artifact_1',
          runId: 'run_1'
        }
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.run_logs.get',
        family: 'fabric',
        target: 'sys.artifact.run_logs.get',
        run: {
          id: 'run_1',
          status: 'success'
        }
      }
    })

    expect(result.operationKind).toBe('fabric_use')
    expect(result.rendererFamily).toBe('generic_tool')
    expect(result.displayToolName).toBe('Artifact Logs')
    expect(result.toolArgs.target).toBe('sys.artifact.run_logs.get')
  })

  it('normalizes CLI tool executions into the cli_tool lane', () => {
    const result = normalizeCompactTool({
      toolName: 'native_cli_tool_use',
      toolArgs: {
        toolId: 'json_echo'
      },
      toolResult: {
        success: true,
        toolId: 'json_echo',
        title: 'JSON Echo',
        executable: '/usr/bin/node',
        args: ['-e', 'echo'],
        exitCode: 0,
        outputMode: 'json',
        parseMode: 'json',
        stdout: '{"echo":"batshit"}',
        stderr: '',
        parsedOutput: {
          echo: 'batshit'
        }
      }
    })

    expect(result.operationKind).toBe('cli_tool')
    expect(result.rendererFamily).toBe('cli_tool')
    expect(result.toolResult.toolId).toBe('json_echo')
    expect(result.toolResult.parsedOutput).toEqual({ echo: 'batshit' })
  })
})
