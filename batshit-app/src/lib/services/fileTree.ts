import type { FileTreeNode, FlatFileEntry } from '$lib/stores/projects.svelte';
import { normalizeProjectExclusions } from '$lib/projects/exclusions';

// Session-authed app proxy in front of batshit-server's token-gated task API.
// The browser never talks to batshit-server's /api/v1 surface directly.
const FILE_TREE_TASK_URL = '/api/file-tree/task';

const FILE_TREE_REQUEST_TIMEOUT_MS = 45_000;

/** Maximum entries requested from batshit-server before the walk is truncated. */
export const FILE_TREE_MAX_ENTRIES = 50_000;

// Build-artifact folders that can balloon a recursive walk. Always excluded
// from the Projects file tree on top of the project's configured exclusions.
const FILE_TREE_BUILD_ARTIFACT_EXCLUSIONS = [
  // Batshit's own packaged Mac app output — 1.4 GB, and walking it was what made
  // the tree take ~10s over ~34k entries. Named `electron-out` on purpose rather
  // than the conventional `dist`, so this stays safe to exclude globally: a user's
  // project may well have a `dist/` they want to SEE. (It was `zig-out` until the
  // Mac shell moved from Vercel Native Zero to Electron; Zig is gone entirely.)
  '**/electron-out/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**'
];

export type FileTreeErrorKind = 'timeout' | 'connection' | 'http' | 'server';

/** Classified file-tree load failure; `message` is safe to show users directly. */
export class FileTreeError extends Error {
  readonly kind: FileTreeErrorKind;

  constructor(kind: FileTreeErrorKind, message: string) {
    super(message);
    this.name = 'FileTreeError';
    this.kind = kind;
  }
}

export interface FileTreeLoadResult {
  tree: FileTreeNode[];
  flat: FlatFileEntry[];
  /** True when batshit-server truncated the walk at the entry limit. */
  truncated: boolean;
  totalBeforeTruncation?: number;
}

export interface DirectoryChildrenResult {
  children: FileTreeNode[];
  /** True when batshit-server truncated the listing at the entry limit. */
  truncated: boolean;
  totalBeforeTruncation?: number;
}

interface ListFilesEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
}

interface ListFilesResponse {
  success?: boolean;
  error?: string;
  files?: ListFilesEntry[];
  truncated?: boolean;
  totalBeforeTruncation?: number;
}

/** Directories first, then alphabetical — the canonical file-tree sort order. */
export function compareFileTreeNodes(
  a: Pick<FileTreeNode, 'name' | 'type'>,
  b: Pick<FileTreeNode, 'name' | 'type'>
): number {
  if (a.type === 'directory' && b.type === 'file') return -1;
  if (a.type === 'file' && b.type === 'directory') return 1;
  return a.name.localeCompare(b.name);
}

export class FileTreeService {
  /** Project exclusions plus the always-on build-artifact exclusions, comma-joined for batshit-server. */
  private static buildExcludePattern(customExclusions: string[]): string {
    const exclusions = new Set([
      ...normalizeProjectExclusions(customExclusions),
      ...FILE_TREE_BUILD_ARTIFACT_EXCLUSIONS
    ]);
    return Array.from(exclusions).join(',');
  }

  /**
   * POST a `list_files` request to batshit-server with the shared 45s timeout
   * and classified `FileTreeError` handling.
   */
  private static async requestListFiles(
    rootPath: string,
    input: Record<string, unknown>
  ): Promise<ListFilesResponse & { files: ListFilesEntry[] }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FILE_TREE_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(FILE_TREE_TASK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serviceName: 'built-in',
          toolName: 'list_files',
          input,
          params: {
            projectPath: rootPath
          }
        }),
        signal: controller.signal
      });
    } catch (error) {
      const errorName = (error as { name?: unknown } | null)?.name;
      if (errorName === 'AbortError' || errorName === 'TimeoutError') {
        throw new FileTreeError(
          'timeout',
          `File tree request timed out after ${FILE_TREE_REQUEST_TIMEOUT_MS / 1000}s`
        );
      }
      console.error('[FileTreeService] Connection error loading file tree:', error);
      throw new FileTreeError('connection', 'Batshit-Server is not responding (connection failed)');
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new FileTreeError(
        'http',
        `Batshit-Server returned HTTP ${response.status} while loading the file tree`
      );
    }

    let result: ListFilesResponse;
    try {
      result = await response.json();
    } catch (error) {
      console.error('[FileTreeService] Unreadable file tree response:', error);
      throw new FileTreeError('server', 'Batshit-Server returned an unreadable file tree response');
    }

    if (!result.success || !Array.isArray(result.files)) {
      const serverError = typeof result.error === 'string' ? result.error.trim() : '';
      throw new FileTreeError(
        'server',
        serverError
          ? `Batshit-Server error: ${serverError}`
          : 'Batshit-Server reported a file tree failure without details'
      );
    }

    return result as ListFilesResponse & { files: ListFilesEntry[] };
  }

  /**
   * Load one directory level for the lazy file tree. `dirPath` is project-relative
   * ('' = project root). Returned children are sorted directories-first
   * alphabetical; directories carry `childrenLoaded: false` until expanded.
   */
  static async loadDirectoryChildren(
    rootPath: string,
    dirPath: string = '',
    customExclusions: string[] = []
  ): Promise<DirectoryChildrenResult> {
    const result = await this.requestListFiles(rootPath, {
      dirPath,
      pattern: '*',
      recursive: false,
      maxDepth: 1,
      includeDirs: true,
      useDefaultExclusions: false, // We provide our own exclusions
      customExcludePattern: this.buildExcludePattern(customExclusions),
      lite: true, // UI tree only needs name/path/type — skips per-entry stat calls
      maxEntries: FILE_TREE_MAX_ENTRIES
    });

    const children: FileTreeNode[] = result.files
      .map((file) => ({
        name: file.name,
        path: file.path,
        type: file.type,
        size: file.size,
        mtime: file.mtime,
        children: undefined,
        isExpanded: false,
        ...(file.type === 'directory' ? { childrenLoaded: false } : {})
      }))
      .sort(compareFileTreeNodes);

    return {
      children,
      truncated: result.truncated === true,
      totalBeforeTruncation:
        typeof result.totalBeforeTruncation === 'number' ? result.totalBeforeTruncation : undefined
    };
  }

  /**
   * Full recursive walk of a project. Used to hydrate the background @ mention
   * index — the visible tree loads lazily through `loadDirectoryChildren`.
   */
  static async loadFileTree(
    rootPath: string,
    maxDepth: number = 10,
    customExclusions: string[] = []
  ): Promise<FileTreeLoadResult> {
    const result = await this.requestListFiles(rootPath, {
      dirPath: '',
      pattern: '*',
      recursive: true,
      includeDirs: true,
      useDefaultExclusions: false, // We provide our own exclusions
      customExcludePattern: this.buildExcludePattern(customExclusions),
      maxDepth: maxDepth,
      lite: true, // UI tree only needs name/path/type — skips per-entry stat calls
      maxEntries: FILE_TREE_MAX_ENTRIES
    });

    // Convert flat file list to tree structure
    const flat = this.buildFlatList(result.files);
    return {
      tree: this.buildTreeFromEntries(result.files),
      flat,
      truncated: result.truncated === true,
      totalBeforeTruncation:
        typeof result.totalBeforeTruncation === 'number' ? result.totalBeforeTruncation : undefined
    };
  }

  /**
   * Convert a flat entry list (project-relative paths) to a hierarchical tree.
   * Missing intermediate directories are created so partial entry sets (for
   * example sidebar search matches from the mention index) still nest correctly.
   */
  static buildTreeFromEntries(
    files: Array<{
      path: string;
      name: string;
      type: 'file' | 'directory';
      size?: number;
      mtime?: string;
    }>
  ): FileTreeNode[] {
    const tree: FileTreeNode[] = [];

    // Sort files to ensure directories come before their contents
    const sorted = [...files].sort((a, b) => {
      const depthA = a.path.split('/').length;
      const depthB = b.path.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.path.localeCompare(b.path);
    });

    for (const file of sorted) {
      const parts = file.path.split('/').filter(p => p);
      let currentLevel = tree;
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        // Find existing node at this level
        let node = currentLevel.find(n => n.name === part);

        if (!node) {
          // Create new node. Intermediate parts are always directories and need
          // a children array so deeper entries nest under them.
          const isLastPart = i === parts.length - 1;
          const isDirectory = !isLastPart || file.type === 'directory';
          node = {
            name: part,
            path: currentPath,
            type: isDirectory ? 'directory' : 'file',
            size: isLastPart ? file.size : undefined,
            mtime: isLastPart ? file.mtime : undefined,
            children: isDirectory ? [] : undefined,
            isExpanded: false
          };

          currentLevel.push(node);
          currentLevel.sort(compareFileTreeNodes);
        }

        // Move to next level if this is a directory
        if (node.type === 'directory' && node.children) {
          currentLevel = node.children;
        }
      }
    }

    return tree;
  }

  private static buildFlatList(files: ListFilesEntry[]): FlatFileEntry[] {
    return files.map((file) => ({
      name: file.name,
      path: file.path,
      type: file.type,
      size: file.size,
      mtime: file.mtime,
      extension: file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined
    }));
  }

  /**
   * Read file content using Batshit-Server
   */
  static async readFile(filePath: string, projectPath: string): Promise<string> {
    try {
      const response = await fetch(FILE_TREE_TASK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serviceName: 'built-in',
          toolName: 'read_file',
          input: {
            filePath
          },
          params: {
            projectPath
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.status}`);
      }

      const result = await response.json();

      if (!result.success || typeof result.content !== 'string') {
        throw new Error(result.error || 'Failed to read file');
      }

      return result.content;
    } catch (error) {
      console.error('[FileTreeService] Error reading file:', error);
      throw error;
    }
  }

  /**
   * Execute a command via Batshit-Server
   */
  static async executeCommand(command: string, projectPath: string, workingDir: string = ''): Promise<any> {
    try {
      const response = await fetch(FILE_TREE_TASK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serviceName: 'built-in',
          toolName: 'execute_command',
          input: {
            command,
            workingDir
          },
          params: {
            projectPath
          }
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to execute command: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error('[FileTreeService] Error executing command:', error)
      throw error
    }
  }
}
