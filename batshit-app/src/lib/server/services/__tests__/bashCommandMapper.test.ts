import { describe, expect, it } from 'vitest'
import {
  mapBashCommandToMode4Tool,
  mapBashCommandToRendererTool,
  resolveNativeBashMapping
} from '../bashCommandMapper'

describe('bashCommandMapper', () => {
  it('maps read-style commands to read renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('cat src/main.ts')
    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.reason).toBe('read-command')
    expect(mapped.args.filePath).toBe('src/main.ts')
    expect(mapped.args.path).toBe('src/main.ts')
  })

  it('maps dot-directory markdown reads to read renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      `/bin/zsh -lc "sed -n '1,220p' .config/project-notes.md"`
    )

    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.reason).toBe('read-command')
    expect(mapped.args.filePath).toBe('.config/project-notes.md')
    expect(mapped.args.path).toBe('.config/project-notes.md')
  })

  it('maps search-style commands to search renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('rg "native_dynamic_mcp" src')
    expect(mapped.toolName).toBe('batshit_server_search_files')
    expect(mapped.reason).toBe('search-command')
  })

  it('maps list/find/tree commands to list renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('find src -maxdepth 2 -type f')
    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
  })

  it('treats rg --files as a list-files lane instead of search_files', () => {
    const mapped = mapBashCommandToRendererTool('rg --files batshit-app/src/lib/components/chat')

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('batshit-app/src/lib/components/chat')
    expect(mapped.args.dirPath).toBe('batshit-app/src/lib/components/chat')
  })

  it('keeps ls pipelines mapped to list renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool("ls -la docs/user-docs/architecture | sed -n '1,200p'")
    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('docs/user-docs/architecture')
    expect(mapped.args.dirPath).toBe('docs/user-docs/architecture')
  })

  it('unwraps docker sandbox bash wrappers before classifying list commands', () => {
    const mapped = mapBashCommandToRendererTool(
      'docker sandbox exec --workdir /Users/example/hello batshit-josh-49fef393f0 /bin/bash -lc ls -la /Users/example/hello'
    )

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('/Users/example/hello')
    expect(mapped.args.dirPath).toBe('/Users/example/hello')
    expect(mapped.args.innerCommand).toBe('ls -la /Users/example/hello')
  })

  it('maps redirect writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('echo "hi" > notes.md')
    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('notes.md')
    expect(mapped.args.path).toBe('notes.md')
    expect(mapped.args.content).toBe('hi')
  })

  it('does not treat fd merge redirects as file writes', () => {
    const mapped = mapBashCommandToRendererTool(
      'curl -s --connect-timeout 5 http://host.docker.internal:8000/object_info 2>&1 | head -c 500'
    )
    expect(mapped.toolName).toBe('native_bash_execute')
    expect(mapped.reason).toBe('fallback-command')
    expect(mapped.args.filePath).toBeUndefined()
  })

  it('maps cat heredoc writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "cat > /tmp/demo.txt <<'EOF'\nhello\nworld\nEOF"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
    expect(mapped.args.content).toBe('hello\nworld')
  })

  it('maps heredoc writes with semicolons in body to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "cat > /tmp/demo.md <<'EOF'\nconst x = 1;\nconst y = 2;\nEOF"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo.md')
    expect(mapped.args.path).toBe('/tmp/demo.md')
    expect(mapped.args.content).toContain('const x = 1;')
  })

  it('maps setup-wrapped heredoc writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "set -euo pipefail\nmkdir -p /tmp/demo\ncat > /tmp/demo/notes.txt <<'EOF'\nalpha\nbeta\nEOF\nwc -l /tmp/demo/notes.txt"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.path).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.content).toBe('alpha\nbeta')
  })

  it('maps in-place edits to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool("sed -i '' 's/foo/bar/' src/main.ts")
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('src/main.ts')
    expect(mapped.args.path).toBe('src/main.ts')
  })

  it('maps in-place edits even when a verification heredoc follows later in the script', () => {
    const mapped = mapBashCommandToRendererTool(
      "perl -pi -e 's/^beta$/bravo/' /tmp/demo.txt\npython3 - <<'PY'\nfrom pathlib import Path\nprint(Path('/tmp/demo.txt').read_text())\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
  })

  it('maps python heredoc file mutations into the edit renderer lane', () => {
    const mapped = mapBashCommandToRendererTool(
      "python - <<'PY'\nfrom pathlib import Path\np=Path('/tmp/demo.txt')\ntext=p.read_text()\np.write_text(text.replace('beta', 'bravo'))\nprint('done')\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('python-file-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
  })

  it('maps cd-wrapped python heredoc file mutations with relative paths into the edit renderer lane', () => {
    const mapped = mapBashCommandToRendererTool(
      "cd /tmp/demo && python3 - <<'PY'\nfrom pathlib import Path\np=Path('notes.txt')\ntext=p.read_text()\np.write_text(text.replace('beta', 'bravo'))\nprint('done')\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('python-file-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.path).toBe('/tmp/demo/notes.txt')
  })

  it('maps apply_patch flows to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: docs/user-docs/architecture/local-first-boundaries.md\n*** End Patch\nPATCH"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('apply-patch')
    expect(mapped.args.filePath).toBe('docs/user-docs/architecture/local-first-boundaries.md')
    expect(mapped.args.path).toBe('docs/user-docs/architecture/local-first-boundaries.md')
  })

  it('maps setup-wrapped apply_patch flows to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "set -euo pipefail\ncd /tmp/demo\napply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: NOTES.md\n@@\n-alpha\n+beta\n*** End Patch\nPATCH"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('apply-patch')
    expect(mapped.args.filePath).toBe('NOTES.md')
    expect(mapped.args.path).toBe('NOTES.md')
  })

  it('keeps unknown command families on execute renderer fallback', () => {
    const mapped = mapBashCommandToRendererTool('npm run lint')
    expect(mapped.toolName).toBe('native_bash_execute')
    expect(mapped.reason).toBe('fallback-command')
  })
})

describe('resolveNativeBashMapping', () => {
  it('returns mapped renderer metadata for native_bash_execute calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'native_bash_execute',
      args: {
        command: 'cd docs && ls architecture'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_list_files')
    expect(resolved?.reason).toBe('list-command')
    expect(resolved?.mappedArgs.path).toBe('architecture')
    expect(resolved?.mappedArgs.originalToolName).toBe('native_bash_execute')
  })

  it('maps sandbox-wrapped native bash list commands back into list_files', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'native_bash_execute',
      args: {
        command:
          'docker sandbox exec --workdir /Users/example/hello batshit-josh-49fef393f0 /bin/bash -lc ls -la /Users/example/hello'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_list_files')
    expect(resolved?.reason).toBe('list-command')
    expect(resolved?.mappedArgs.path).toBe('/Users/example/hello')
    expect(resolved?.mappedArgs.originalToolName).toBe('native_bash_execute')
  })

  it('returns mapped renderer metadata for managed CLI bash helper calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute',
      args: {
        command: 'cat docs/example.md'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_read_file')
    expect(resolved?.reason).toBe('read-command')
    expect(resolved?.mappedArgs.path).toBe('docs/example.md')
    expect(resolved?.mappedArgs.originalToolName).toBe(
      'mcp.batshit_cli_internal_tools.batshit_server_bash_execute'
    )
  })

  it('returns mapped renderer metadata for Claude managed CLI bash helper calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'mcp__batshit_cli_internal_tools__batshit_server_bash_execute',
      args: {
        command: 'rg "zip-control" batshit-app/src'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_search_files')
    expect(resolved?.reason).toBe('search-command')
    expect(resolved?.mappedArgs.originalToolName).toBe(
      'mcp__batshit_cli_internal_tools__batshit_server_bash_execute'
    )
  })

  it('returns null for non-native tools', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'batshit_server_execute_command',
      args: {
        command: 'pwd'
      }
    })
    expect(resolved).toBeNull()
  })
})

describe('mapBashCommandToMode4Tool', () => {
  it('preserves shared rg search classification for Mode 4 adapters', () => {
    const mapped = mapBashCommandToMode4Tool('rg "tool-result" batshit-app/src')

    expect(mapped.toolName).toBe('batshit_server_search_files')
    expect(mapped.reason).toBe('search-command')
  })

  it('preserves shared rg --files classification for Mode 4 adapters', () => {
    const mapped = mapBashCommandToMode4Tool('rg --files batshit-app/src/lib/components/chat')

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('batshit-app/src/lib/components/chat')
  })

  it('maps unknown shell commands back to Mode 4 execute_command telemetry', () => {
    const mapped = mapBashCommandToMode4Tool('npm run check')

    expect(mapped.toolName).toBe('batshit_server_execute_command')
    expect(mapped.reason).toBe('fallback-command')
  })
})
