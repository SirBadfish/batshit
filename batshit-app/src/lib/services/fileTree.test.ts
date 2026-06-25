import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FILE_TREE_MAX_ENTRIES, FileTreeError, FileTreeService } from './fileTree'

describe('FileTreeService.loadDirectoryChildren', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function okResponse(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body))
  }

  it('requests a single lite level for the target directory', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ success: true, files: [] })
    )

    await FileTreeService.loadDirectoryChildren('/workspace', 'src/lib', ['**/my-custom/**'])

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
    expect(requestBody.input.dirPath).toBe('src/lib')
    expect(requestBody.input.recursive).toBe(false)
    expect(requestBody.input.maxDepth).toBe(1)
    expect(requestBody.input.includeDirs).toBe(true)
    expect(requestBody.input.lite).toBe(true)
    expect(requestBody.input.maxEntries).toBe(FILE_TREE_MAX_ENTRIES)
    expect(requestBody.input.customExcludePattern).toContain('**/my-custom/**')
    expect(requestBody.input.customExcludePattern).toContain('**/zig-out/**')
    expect(requestBody.params.projectPath).toBe('/workspace')
  })

  it('defaults to the project root with an empty dirPath', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ success: true, files: [] })
    )

    await FileTreeService.loadDirectoryChildren('/workspace')

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
    expect(requestBody.input.dirPath).toBe('')
  })

  it('returns children sorted directories-first alphabetical with lazy markers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({
        success: true,
        files: [
          { name: 'zeta.txt', path: 'src/zeta.txt', type: 'file' },
          { name: 'beta', path: 'src/beta', type: 'directory' },
          { name: 'alpha.txt', path: 'src/alpha.txt', type: 'file' },
          { name: 'app', path: 'src/app', type: 'directory' }
        ]
      })
    )

    const result = await FileTreeService.loadDirectoryChildren('/workspace', 'src')

    expect(result.children.map((child) => child.name)).toEqual([
      'app',
      'beta',
      'alpha.txt',
      'zeta.txt'
    ])
    const directories = result.children.filter((child) => child.type === 'directory')
    expect(directories.every((dir) => dir.childrenLoaded === false)).toBe(true)
    expect(directories.every((dir) => dir.isExpanded === false)).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('surfaces directory-level truncation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({
        success: true,
        files: [{ name: 'a.txt', path: 'big/a.txt', type: 'file' }],
        truncated: true,
        totalBeforeTruncation: 60001
      })
    )

    const result = await FileTreeService.loadDirectoryChildren('/workspace', 'big')

    expect(result.truncated).toBe(true)
    expect(result.totalBeforeTruncation).toBe(60001)
  })

  it('classifies request aborts as timeout errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError')
    )

    await expect(FileTreeService.loadDirectoryChildren('/workspace', 'src')).rejects.toMatchObject({
      name: 'FileTreeError',
      kind: 'timeout',
      message: 'File tree request timed out after 45s'
    })
  })

  it('passes through the server-reported error string on success:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ success: false, error: 'Directory does not exist: src/gone' })
    )

    const failure = await FileTreeService.loadDirectoryChildren('/workspace', 'src/gone').catch(
      (error) => error
    )

    expect(failure).toBeInstanceOf(FileTreeError)
    expect(failure.kind).toBe('server')
    expect(failure.message).toBe('Batshit-Server error: Directory does not exist: src/gone')
  })
})

describe('FileTreeService.buildTreeFromEntries', () => {
  it('creates missing intermediate directories for deep entries', () => {
    const tree = FileTreeService.buildTreeFromEntries([
      { name: 'deep.ts', path: 'src/lib/utils/deep.ts', type: 'file' }
    ])

    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ name: 'src', type: 'directory' })
    const lib = tree[0].children?.[0]
    expect(lib).toMatchObject({ name: 'lib', type: 'directory', path: 'src/lib' })
    const utils = lib?.children?.[0]
    expect(utils).toMatchObject({ name: 'utils', type: 'directory' })
    expect(utils?.children?.[0]).toMatchObject({
      name: 'deep.ts',
      type: 'file',
      path: 'src/lib/utils/deep.ts'
    })
  })

  it('sorts each level directories-first alphabetical', () => {
    const tree = FileTreeService.buildTreeFromEntries([
      { name: 'readme.md', path: 'readme.md', type: 'file' },
      { name: 'src', path: 'src', type: 'directory' },
      { name: 'assets', path: 'assets', type: 'directory' },
      { name: 'app.ts', path: 'app.ts', type: 'file' }
    ])

    expect(tree.map((node) => node.name)).toEqual(['assets', 'src', 'app.ts', 'readme.md'])
  })
})

describe('FileTreeService.loadFileTree', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function okResponse(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body))
  }

  it('requests lite mode with an entry cap and build-artifact exclusions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ success: true, files: [] })
    )

    const result = await FileTreeService.loadFileTree('/workspace', 10, ['**/my-custom/**'])

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
    expect(requestBody.input.lite).toBe(true)
    expect(requestBody.input.maxEntries).toBe(FILE_TREE_MAX_ENTRIES)
    expect(requestBody.input.customExcludePattern).toContain('**/my-custom/**')
    expect(requestBody.input.customExcludePattern).toContain('**/zig-out/**')
    expect(requestBody.input.customExcludePattern).toContain('**/.svelte-kit/**')
    expect(result).toMatchObject({ tree: [], flat: [], truncated: false })
  })

  it('surfaces server truncation in the returned data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({
        success: true,
        files: [{ name: 'a.txt', path: 'a.txt', type: 'file' }],
        truncated: true,
        totalBeforeTruncation: 123456
      })
    )

    const result = await FileTreeService.loadFileTree('/workspace')

    expect(result.truncated).toBe(true)
    expect(result.totalBeforeTruncation).toBe(123456)
    expect(result.flat).toHaveLength(1)
  })

  it('classifies request aborts as timeout errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError')
    )

    await expect(FileTreeService.loadFileTree('/workspace')).rejects.toMatchObject({
      name: 'FileTreeError',
      kind: 'timeout',
      message: 'File tree request timed out after 45s'
    })
  })

  it('classifies network failures as connection errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(FileTreeService.loadFileTree('/workspace')).rejects.toMatchObject({
      name: 'FileTreeError',
      kind: 'connection',
      message: 'Batshit-Server is not responding (connection failed)'
    })
  })

  it('classifies non-OK responses as http errors with the status code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('busted', { status: 503 })
    )

    await expect(FileTreeService.loadFileTree('/workspace')).rejects.toMatchObject({
      name: 'FileTreeError',
      kind: 'http',
      message: 'Batshit-Server returned HTTP 503 while loading the file tree'
    })
  })

  it('passes through the server-reported error string on success:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ success: false, error: 'Project path does not exist: /workspace' })
    )

    const failure = await FileTreeService.loadFileTree('/workspace').catch((error) => error)

    expect(failure).toBeInstanceOf(FileTreeError)
    expect(failure.kind).toBe('server')
    expect(failure.message).toBe('Batshit-Server error: Project path does not exist: /workspace')
  })
})

describe('FileTreeService.readFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts empty file content from Batshit-Server', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          content: ''
        })
      )
    )

    await expect(FileTreeService.readFile('empty.txt', '/workspace')).resolves.toBe('')
  })

  it('fails loudly when Batshit-Server does not return string content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          content: null
        })
      )
    )

    await expect(FileTreeService.readFile('missing.txt', '/workspace')).rejects.toThrow(
      'Failed to read file'
    )
  })
})
