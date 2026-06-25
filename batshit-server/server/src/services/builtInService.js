const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { glob } = require('glob');
const { minimatch } = require('minimatch');
const { nanoid } = require('nanoid');
const logger = require('../utils/logger');
const { lintCode } = require('../plugins/built-in/tools/lint_code');
const redisService = require('./redisService');

const PRODUCT_REPO_ROOT = path.resolve(__dirname, '../../../../');
const PRODUCT_SOURCE_WRITE_BLOCK_MESSAGE =
  'Batshit product source is read-only from in-app agents. Use an external coding workspace to edit files inside the Batshit repo.';
const PRODUCT_WRITE_COMMAND_PATTERNS = [
  /(^|\s)(?:cat|tee|touch|mkdir|rm|mv|cp|ln)\b/i,
  /\b(?:sed|perl)\s+-i\b/i,
  /\bapply_patch\b/i,
  /(^|[^\w])>>?($|[^\w])/
];

const LEGACY_EXCLUSION_NORMALIZATION_MAP = new Map([
  ['.git/**', '**/.git/**'],
  ['.env', '**/.env'],
  ['.env.*', '**/.env.*'],
  ['node_modules/**', '**/node_modules/**'],
  ['dist/**', '**/dist/**'],
  ['build/**', '**/build/**'],
  ['coverage/**', '**/coverage/**'],
  ['.next/**', '**/.next/**'],
  ['.nuxt/**', '**/.nuxt/**'],
  ['.cache/**', '**/.cache/**'],
  ['*.log', '**/*.log']
]);

const LIST_FILES_STAT_CONCURRENCY = 64;
const LIST_FILES_DEFAULT_MAX_ENTRIES = 50000;

/**
 * Run an async mapper over items with a bounded number of in-flight calls.
 * Results keep the original item order.
 */
async function mapWithBoundedConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// Import Ruff WASM for Python formatting
let ruffWasm = null;
let ruffWorkspace = null;

// Initialize Ruff WASM module
async function initializeRuff() {
  if (!ruffWasm) {
    try {
      ruffWasm = await import('@astral-sh/ruff-wasm-nodejs');
      ruffWorkspace = new ruffWasm.Workspace({
        'line-length': 88,
        'indent-width': 4,
        format: {
          'indent-style': 'space',
          'quote-style': 'double',
        }
      });
      logger.info('Ruff WASM initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize Ruff WASM: ${error.message}`);
      throw error;
    }
  }
  return { ruffWasm, ruffWorkspace };
}

class BuiltInService {
  constructor() {
    this.name = 'built-in';
    this.version = '0.4.0';
    this.description = 'Comprehensive built-in tools for file operations, analysis, git, linting, and system commands';
    this.redisService = redisService;
  }

  async ensureRedis() {
    if (!this.redisService.connected) {
      await this.redisService.connect();
    }
    return this.redisService.client;
  }

  // Comprehensive default exclude list
  static get COMPREHENSIVE_EXCLUDE_LIST() {
    return "node_modules/**,dist/**,.git/**,*.log,npm-debug.log*,yarn-debug.log*,yarn-error.log*,lerna-debug.log*,.pnpm-debug.log*,report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json,pids/**,*.pid,*.seed,*.pid.lock,lib-cov/**,coverage/**,*.lcov,.nyc_output/**,.grunt/**,bower_components/**,.lock-wscript,build/Release/**,jspm_packages/**,web_modules/**,*.tsbuildinfo,.npm/**,.eslintcache,.stylelintcache,.rpt2_cache/**,.rts2_cache_cjs/**,.rts2_cache_es/**,.rts2_cache_umd/**,.node_repl_history,*.tgz,.yarn-integrity,.env,.env.*,.env.*.local,.cache/**,.parcel-cache/**,.next/**,out/**,.nuxt/**,dist/**,.vuepress/dist/**,.temp/**,.vitepress/dist/**,.vitepress/cache/**,.docusaurus/**,.serverless/**,.fusebox/**,.dynamodb/**,.tern-port,.vscode-test/**,.yarn/cache/**,.yarn/unplugged/**,.yarn/build-state.yml,.yarn/install-state.gz,.pnp.*,**/*.pyc,**/*~,**/__pycache__/**,**/.DS_Store,**/.classpath,**/.project,**/.settings/**,**/*.class,**/*.jar,**/*.war,**/*.ear,**/target/**,**/.idea/**,**/*.iml,**/*.ipr,**/*.iws,**/bin/**,**/obj/**";
  }

  // Shorter default exclude list for basic filtering
  static get SHORTER_EXCLUDE_LIST() {
    return "node_modules/**,dist/**,.git/**,*.log,**/__pycache__/**,**/.DS_Store";
  }

  _normalizeExcludePatternString(patternString) {
    if (!patternString || patternString.trim() === '') {
      return '';
    }

    const normalized = new Set();
    for (const pattern of patternString.split(',')) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;
      normalized.add(LEGACY_EXCLUSION_NORMALIZATION_MAP.get(trimmed) ?? trimmed);
    }

    return Array.from(normalized).join(',');
  }

  /**
   * Helper method to determine effective exclude pattern based on parameters
   */
  _getEffectiveExcludePattern(params) {
    const { useDefaultExclusions, customExcludePattern } = params;
    
    if (useDefaultExclusions) {
      const patternToReturn = BuiltInService.COMPREHENSIVE_EXCLUDE_LIST;
      return this._normalizeExcludePatternString(patternToReturn);
    }

    // If not using default exclusions:
    if (customExcludePattern && customExcludePattern.trim() !== '') {
      // Use custom pattern if provided and not just whitespace
      return this._normalizeExcludePatternString(customExcludePattern);
    } else {
      // If custom pattern is empty or whitespace, apply NO exclusions
      return ''; // Return empty string for no exclusions
    }
  }

  async _getListablePathStats(fullPath) {
    try {
      return await fsp.stat(fullPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      try {
        return await fsp.lstat(fullPath);
      } catch (lstatError) {
        if (lstatError?.code === 'ENOENT') {
          return null;
        }
        throw lstatError;
      }
    }
  }

  /**
   * Helper method to check if a file path should be excluded
   */
  _isExcluded(filePath, excludePatternsArray) {
    if (!excludePatternsArray || excludePatternsArray.length === 0) {
      return false;
    }
    
    return excludePatternsArray.some(pattern => {
      if (!pattern || pattern.trim() === '') return false;
      return minimatch(filePath, pattern.trim()) ||
             minimatch(`${filePath}/`, pattern.trim());
    });
  }

  _isPathWithinRoot(rootPath, targetPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  _isProtectedProductRepoPath(targetPath) {
    return this._isPathWithinRoot(PRODUCT_REPO_ROOT, path.resolve(targetPath));
  }

  _assertProductRepoWriteAllowed(targetPath) {
    if (this._isProtectedProductRepoPath(targetPath)) {
      throw new Error(PRODUCT_SOURCE_WRITE_BLOCK_MESSAGE);
    }
  }

  _assertProtectedExecuteCommandAllowed(effectiveCwd, command) {
    const commandText = typeof command === 'string' ? command.trim() : '';
    if (!commandText) return;

    const touchesProtectedRepoByCwd = this._isProtectedProductRepoPath(effectiveCwd);
    const mentionsProtectedRepoPath = commandText.includes(PRODUCT_REPO_ROOT);
    const looksMutating = PRODUCT_WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText));

    if ((touchesProtectedRepoByCwd || mentionsProtectedRepoPath) && looksMutating) {
      throw new Error(PRODUCT_SOURCE_WRITE_BLOCK_MESSAGE);
    }
  }

  // FILE OPERATIONS

  /**
   * Read a file and return its content
   */
  async readFile(projectPath, { filePath, encoding = 'utf8' }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      
      const content = await fsp.readFile(absolutePath, { encoding });
      const stats = await fsp.stat(absolutePath);
      
      // Calculate line count
      const lineCount = content.split('\n').length;
      
      // Get file extension for language detection
      const ext = path.extname(filePath).slice(1) || 'text';
      
      return {
        success: true,
        tool: 'read_file',
        toolName: 'Read File',  // Proper display name
        filePath,
        absolutePath,
        content,
        encoding,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        lineCount,
        language: ext,
        // Include the tool input for display
        toolInput: {
          filePath,
          encoding
        },
        // Include metadata for direct use in rendering
        metadata: {
          toolName: 'Read File',
          language: ext,
          path: absolutePath,
          lineCount: lineCount,
          size: stats.size,
          lastModified: stats.mtime.toISOString()
        }
      };
    } catch (error) {
      logger.error(`Error reading file ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'read_file',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Write content to a file
   */
  async writeFile(projectPath, { filePath, content, encoding = 'utf8', createPath = true }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      this._assertProductRepoWriteAllowed(absolutePath);
      
      if (createPath) {
        const dirPath = path.dirname(absolutePath);
        await fsp.mkdir(dirPath, { recursive: true });
      }
      
      await fsp.writeFile(absolutePath, content, { encoding });
      const stats = await fsp.stat(absolutePath);
      
      // Calculate line count
      const lineCount = content.split('\n').length;
      
      // Get file extension for language detection
      const ext = path.extname(filePath).slice(1) || 'text';
      
      return {
        success: true,
        tool: 'write_file',
        toolName: 'Write File',  // Proper display name
        filePath,
        absolutePath,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        lineCount,
        language: ext,
        // Include metadata for direct use in rendering
        metadata: {
          toolName: 'Write File',
          language: ext,
          path: absolutePath,
          lineCount: lineCount
        }
      };
    } catch (error) {
      logger.error(`Error writing file ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'write_file',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Edit a file by replacing specific content
   */
  async editFile(projectPath, { filePath, oldContent, newContent, edits }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      this._assertProductRepoWriteAllowed(absolutePath);
      
      // Read the current file content
      const currentContent = await fsp.readFile(absolutePath, 'utf8');
      let modifiedContent = currentContent;
      
      // Apply edits
      if (edits && Array.isArray(edits) && edits.length > 0) {
        // Apply multiple edits in sequence
        for (const edit of edits) {
          if (!modifiedContent.includes(edit.oldContent)) {
            return {
              success: false,
              tool: 'edit_file',
              error: `Could not find text to replace: "${edit.oldContent.substring(0, 50)}..."`,
              filePath
            };
          }
          modifiedContent = modifiedContent.replace(edit.oldContent, edit.newContent);
        }
      } else if (oldContent && newContent !== undefined) {
        // Single edit
        if (!modifiedContent.includes(oldContent)) {
          return {
            success: false,
            tool: 'edit_file',
            error: `Could not find text to replace: "${oldContent.substring(0, 50)}..."`,
            filePath
          };
        }
        modifiedContent = modifiedContent.replace(oldContent, newContent);
      } else {
        return {
          success: false,
          tool: 'edit_file',
          error: 'Must provide either oldContent/newContent or edits array',
          filePath
        };
      }
      
      // Write the modified content back
      await fsp.writeFile(absolutePath, modifiedContent, 'utf8');
      
      // Create a simple diff for display
      const changes = [];
      if (edits && Array.isArray(edits)) {
        edits.forEach(edit => {
          changes.push({
            removed: edit.oldContent,
            added: edit.newContent
          });
        });
      } else {
        changes.push({
          removed: oldContent,
          added: newContent
        });
      }
      
      // Generate an enhanced diff with full context and line numbers
      const modifiedLines = modifiedContent.split('\n');
      const originalLines = currentContent.split('\n');
      let diff = '';
      let contextLines = 3; // Number of context lines to show before/after changes
      
      // Find all changed line indices
      const changedIndices = new Set();
      changes.forEach(change => {
        const oldText = change.removed;
        const newText = change.added;
        
        // Find where in the original content this change occurred
        let startIndex = currentContent.indexOf(oldText);
        if (startIndex !== -1) {
          // Count line number where change starts
          const linesBefore = currentContent.substring(0, startIndex).split('\n').length - 1;
          const linesInOld = oldText.split('\n').length;
          const linesInNew = newText.split('\n').length;
          
          // Mark all affected lines
          for (let i = linesBefore; i < linesBefore + Math.max(linesInOld, linesInNew); i++) {
            changedIndices.add(i);
          }
        }
      });
      
      // Build the diff with context
      diff = `--- ${filePath}\n+++ ${filePath} (modified)\n`;
      diff += `@@ File has ${modifiedLines.length} lines after edit @@\n\n`;
      
      for (let i = 0; i < Math.max(originalLines.length, modifiedLines.length); i++) {
        const lineNum = i + 1;
        const origLine = originalLines[i];
        const modLine = modifiedLines[i];
        
        // Check if we should show this line (changed or within context)
        let showLine = changedIndices.has(i);
        if (!showLine) {
          // Check if within context range of any change
          for (let changed of changedIndices) {
            if (Math.abs(i - changed) <= contextLines) {
              showLine = true;
              break;
            }
          }
        }
        
        if (showLine) {
          if (origLine === modLine) {
            // Unchanged line (context)
            diff += `  ${String(lineNum).padStart(4)} | ${origLine || ''}\n`;
          } else if (origLine !== undefined && modLine === undefined) {
            // Line was deleted
            diff += `- ${String(lineNum).padStart(4)} | ${origLine}\n`;
          } else if (origLine === undefined && modLine !== undefined) {
            // Line was added
            diff += `+ ${String(lineNum).padStart(4)} | ${modLine}\n`;
          } else {
            // Line was modified
            diff += `- ${String(lineNum).padStart(4)} | ${origLine}\n`;
            diff += `+ ${String(lineNum).padStart(4)} | ${modLine}\n`;
          }
        } else if (i > 0 && i < modifiedLines.length - 1) {
          // Add ellipsis if we're skipping lines
          const prevShown = showLine || (i > 0 && changedIndices.has(i - 1));
          const nextWillShow = i < modifiedLines.length - 1 && 
                               (changedIndices.has(i + 1) || 
                                [...changedIndices].some(c => Math.abs((i + 1) - c) <= contextLines));
          
          if (prevShown && !showLine && nextWillShow) {
            // Only add ellipsis once between shown sections
            if (!diff.endsWith('       | ...\n')) {
              diff += '       | ...\n';
            }
          }
        }
      }
      
      // Calculate line count of the diff
      const diffLineCount = diff.split('\n').length;
      
      // Get file extension for language detection
      const ext = path.extname(filePath).slice(1) || 'text';
      
      return {
        success: true,
        tool: 'edit_file',
        toolName: 'Edit File',  // Proper display name
        filePath,
        absolutePath,
        changes: changes.length,
        diff: diff,
        lineCount: diffLineCount,
        language: ext,
        // Include the tool input for display
        toolInput: {
          filePath,
          edits: edits || [{ oldContent, newContent }]
        },
        // Include metadata for direct use in rendering
        metadata: {
          toolName: 'Edit File',
          language: ext,
          path: absolutePath,
          lineCount: diffLineCount,
          totalLines: modifiedLines.length,
          changesCount: changes.length
        }
      };
    } catch (error) {
      logger.error(`Error editing file ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'edit_file',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Create an empty file or directory
   */
  async createFile(projectPath, { filePath, isDirectory = false }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      this._assertProductRepoWriteAllowed(absolutePath);

      if (isDirectory) {
        await fsp.mkdir(absolutePath, { recursive: true });
        return {
          success: true,
          tool: 'create_file',
          toolName: 'Create Directory',
          filePath,
          absolutePath,
          isDirectory: true,
          message: `Directory created: ${filePath}`
        };
      } else {
        // Ensure parent directory exists
        const dirPath = path.dirname(absolutePath);
        await fsp.mkdir(dirPath, { recursive: true });
        
        // Create empty file if it doesn't exist
        if (!fs.existsSync(absolutePath)) {
          await fsp.writeFile(absolutePath, '');
        } else {
          return {
            success: false,
            tool: 'create_file',
            error: `File already exists: ${filePath}`,
            filePath
          };
        }
        
        return {
          success: true,
          tool: 'create_file',
          toolName: 'Create File',
          filePath,
          absolutePath,
          isDirectory: false,
          message: `File created: ${filePath}`
        };
      }
    } catch (error) {
      logger.error(`Error creating file/directory ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'create_file',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Delete a file or directory
   */
  async deleteFile(projectPath, { filePath, recursive = true }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      this._assertProductRepoWriteAllowed(absolutePath);
      
      const stats = await fsp.stat(absolutePath).catch(() => null);
      if (!stats) {
        return {
          success: false,
          tool: 'delete_file',
          error: `File or directory does not exist: ${filePath}`,
          filePath
        };
      }
      
      if (stats.isDirectory()) {
        if (!recursive) {
          // Check if directory is empty
          const files = await fsp.readdir(absolutePath);
          if (files.length > 0) {
            return {
              success: false,
              tool: 'delete_file',
              error: `Directory not empty and recursive is false: ${filePath}`,
              filePath
            };
          }
        }
        await fsp.rm(absolutePath, { recursive, force: true });
        return {
          success: true,
          tool: 'delete_file',
          toolName: 'Delete Directory',
          filePath,
          isDirectory: true,
          message: `Directory deleted: ${filePath}`
        };
      } else {
        await fsp.unlink(absolutePath);
        return {
          success: true,
          tool: 'delete_file',
          toolName: 'Delete File',
          filePath,
          isDirectory: false,
          message: `File deleted: ${filePath}`
        };
      }
    } catch (error) {
      logger.error(`Error deleting file/directory ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'delete_file',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * Rename a file or directory
   */
  async renameFile(projectPath, params) {
    const { sourcePath, targetPath } = params;
    
    if (!sourcePath || !targetPath) {
      return {
        success: false,
        tool: 'rename_file',
        error: `Missing required parameters. Expected sourcePath and targetPath. Received: ${JSON.stringify(params)}`,
        params
      };
    }
    
    try {
      const absoluteSourcePath = path.resolve(projectPath, sourcePath);
      const absoluteTargetPath = path.resolve(projectPath, targetPath);
      
      this.validatePathWithinProject(projectPath, absoluteSourcePath);
      this.validatePathWithinProject(projectPath, absoluteTargetPath);
      this._assertProductRepoWriteAllowed(absoluteSourcePath);
      this._assertProductRepoWriteAllowed(absoluteTargetPath);
      
      if (!fs.existsSync(absoluteSourcePath)) {
        return {
          success: false,
          tool: 'rename_file',
          error: `Source path does not exist: ${sourcePath}`,
          sourcePath: sourcePath,
          targetPath: targetPath
        };
      }
      
      if (fs.existsSync(absoluteTargetPath)) {
        return {
          success: false,
          tool: 'rename_file',
          error: `Target path already exists: ${targetPath}`,
          sourcePath: sourcePath,
          targetPath: targetPath
        };
      }
      
      // Ensure target directory exists
      const targetDir = path.dirname(absoluteTargetPath);
      await fsp.mkdir(targetDir, { recursive: true });
      
      // Perform the rename
      await fsp.rename(absoluteSourcePath, absoluteTargetPath);
      
      const stats = await fsp.stat(absoluteTargetPath);
      return {
        success: true,
        tool: 'rename_file',
        toolName: 'Rename File',
        sourcePath: sourcePath,
        targetPath: targetPath,
        isDirectory: stats.isDirectory(),
        message: `Successfully renamed ${sourcePath} to ${targetPath}`
      };
    } catch (error) {
      logger.error(`Error renaming ${sourcePath} to ${targetPath}: ${error.message}`);
      return {
        success: false,
        tool: 'rename_file',
        error: error.message,
        sourcePath: sourcePath,
        targetPath: targetPath
      };
    }
  }

  /**
   * Move a file or directory to a new location
   * This is essentially the same as rename but with clearer semantics for moving between directories
   */
  async moveFile(projectPath, params) {
    const { sourcePath, targetPath } = params;
    
    if (!sourcePath || !targetPath) {
      return {
        success: false,
        tool: 'move_file',
        error: `Missing required parameters. Expected sourcePath and targetPath. Received: ${JSON.stringify(params)}`,
        params
      };
    }
    
    try {
      const absoluteSourcePath = path.resolve(projectPath, sourcePath);
      const absoluteTargetPath = path.resolve(projectPath, targetPath);
      
      this.validatePathWithinProject(projectPath, absoluteSourcePath);
      this.validatePathWithinProject(projectPath, absoluteTargetPath);
      this._assertProductRepoWriteAllowed(absoluteSourcePath);
      this._assertProductRepoWriteAllowed(absoluteTargetPath);
      
      if (!fs.existsSync(absoluteSourcePath)) {
        return {
          success: false,
          tool: 'move_file',
          error: `Source path does not exist: ${sourcePath}`,
          sourcePath: sourcePath,
          targetPath: targetPath
        };
      }
      
      if (fs.existsSync(absoluteTargetPath)) {
        return {
          success: false,
          tool: 'move_file',
          error: `Target path already exists: ${targetPath}`,
          sourcePath: sourcePath,
          targetPath: targetPath
        };
      }
      
      // Ensure target directory exists
      const targetDir = path.dirname(absoluteTargetPath);
      await fsp.mkdir(targetDir, { recursive: true });
      
      // Perform the move (same as rename)
      await fsp.rename(absoluteSourcePath, absoluteTargetPath);
      
      const stats = await fsp.stat(absoluteTargetPath);
      return {
        success: true,
        tool: 'move_file',
        toolName: 'Move File',
        sourcePath: sourcePath,
        targetPath: targetPath,
        isDirectory: stats.isDirectory(),
        message: `Successfully moved ${sourcePath} to ${targetPath}`
      };
    } catch (error) {
      logger.error(`Error moving ${sourcePath} to ${targetPath}: ${error.message}`);
      return {
        success: false,
        tool: 'move_file',
        error: error.message,
        sourcePath: sourcePath,
        targetPath: targetPath
      };
    }
  }

  /**
   * Copy a file or directory
   */
  async copyFile(projectPath, params) {
    const { sourcePath, targetPath, recursive = true } = params;
    
    if (!sourcePath || !targetPath) {
      return {
        success: false,
        tool: 'copy_file',
        error: `Missing required parameters. Expected sourcePath and targetPath. Received: ${JSON.stringify(params)}`,
        params
      };
    }
    
    try {
      const absoluteSourcePath = path.resolve(projectPath, sourcePath);
      const absoluteTargetPath = path.resolve(projectPath, targetPath);
      
      this.validatePathWithinProject(projectPath, absoluteSourcePath);
      this.validatePathWithinProject(projectPath, absoluteTargetPath);
      this._assertProductRepoWriteAllowed(absoluteTargetPath);
      
      if (!fs.existsSync(absoluteSourcePath)) {
        return {
          success: false,
          tool: 'copy_file',
          error: `Source path does not exist: ${sourcePath}`,
          sourcePath,
          targetPath
        };
      }
      
      const stats = await fsp.stat(absoluteSourcePath);
      
      if (stats.isDirectory()) {
        // Copy directory
        await this._copyDirectory(absoluteSourcePath, absoluteTargetPath, recursive);
        return {
          success: true,
          tool: 'copy_file',
          toolName: 'Copy Directory',
          sourcePath,
          targetPath,
          isDirectory: true,
          message: `Directory copied from ${sourcePath} to ${targetPath}`
        };
      } else {
        // Copy file
        // Ensure target directory exists
        const targetDir = path.dirname(absoluteTargetPath);
        await fsp.mkdir(targetDir, { recursive: true });
        
        await fsp.copyFile(absoluteSourcePath, absoluteTargetPath);
        return {
          success: true,
          tool: 'copy_file',
          toolName: 'Copy File',
          sourcePath,
          targetPath,
          isDirectory: false,
          message: `File copied from ${sourcePath} to ${targetPath}`
        };
      }
    } catch (error) {
      logger.error(`Error copying ${sourcePath} to ${targetPath}: ${error.message}`);
      return {
        success: false,
        tool: 'copy_file',
        error: error.message,
        sourcePath,
        targetPath
      };
    }
  }

  /**
   * Get file or directory information
   */
  async getFileInfo(projectPath, { filePath }) {
    try {
      const absolutePath = path.resolve(projectPath, filePath);
      this.validatePathWithinProject(projectPath, absolutePath);
      
      if (!fs.existsSync(absolutePath)) {
        return {
          success: false,
          tool: 'get_file_info',
          error: `Path does not exist: ${filePath}`,
          filePath
        };
      }
      
      const stats = await fsp.stat(absolutePath);
      const result = {
        success: true,
        tool: 'get_file_info',
        filePath,
        absolutePath,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime
      };
      
      if (stats.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        result.extension = ext ? ext.substring(1) : '';
        
        // Try to determine mime type
        result.mimeType = this._guessMimeType(filePath);
        
        // For smaller text files, include content preview
        if (stats.size < 1024 * 50) { // Less than 50KB
          try {
            result.isText = this._isLikelyTextFile(filePath);
            
            if (result.isText) {
              const content = await fsp.readFile(absolutePath, 'utf8');
              result.previewContent = content.substring(0, 500); // First 500 chars
              result.lines = content.split('\n').length;
            }
          } catch (previewError) {
            // Skip preview on error
          }
        }
      } else if (stats.isDirectory()) {
        // Include directory contents count
        const entries = await fsp.readdir(absolutePath);
        result.itemCount = entries.length;
      }
      
      return result;
    } catch (error) {
      logger.error(`Error getting file info for ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'get_file_info',
        error: error.message,
        filePath
      };
    }
  }

  /**
   * List files in a directory
   *
   * `lite: true` returns only { name, path, type } per entry using type info
   * from the directory walk itself (no per-entry stat calls). Default mode
   * keeps size/mtime and gathers stats with bounded concurrency.
   *
   * `maxEntries` bounds the walk result; when the walk yields more entries the
   * response includes `truncated: true` plus `totalBeforeTruncation`.
   */
  async listFiles(projectPath, { dirPath = '', pattern = '*', excludePattern = '', maxDepth = 1, includeDirs = false, recursive = false, useDefaultExclusions = false, customExcludePattern = '', lite = false, maxEntries = LIST_FILES_DEFAULT_MAX_ENTRIES }) {
    try {
      // Handle recursive parameter - if recursive is true and no maxDepth specified, set to unlimited
      // If maxDepth is specified, use it even when recursive is true
      const actualMaxDepth = recursive && !maxDepth ? 0 : maxDepth;

      // Determine effective exclude pattern using helper method
      const excludePatternString = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });

      const excludePatterns = excludePatternString ? excludePatternString.split(',').map(p => p.trim()).filter(p => p) : [];

      const targetDir = dirPath ? path.join(projectPath, dirPath) : projectPath;
      this.validatePathWithinProject(projectPath, targetDir);

      // Use glob for pattern matching. withFileTypes gives us Path entries with
      // directory/file type info from the walk itself, so type classification
      // does not require an extra stat per entry.
      const globPattern = actualMaxDepth === 0 || actualMaxDepth > 1 ? `**/${pattern}` : pattern;

      const globEntries = await glob(globPattern, {
        cwd: targetDir,
        dot: true,
        ignore: excludePatterns,
        maxDepth: actualMaxDepth > 0 ? actualMaxDepth : undefined, // glob's depth is 0-indexed for levels, 0 means no limit if not specified
        withFileTypes: true
      });

      // Bound the result set so huge workspaces cannot produce unbounded payloads.
      const entryLimit = Number.isFinite(maxEntries) && maxEntries > 0
        ? Math.floor(maxEntries)
        : LIST_FILES_DEFAULT_MAX_ENTRIES;
      const totalBeforeTruncation = globEntries.length;
      const truncated = totalBeforeTruncation > entryLimit;
      const walkEntries = truncated ? globEntries.slice(0, entryLimit) : globEntries;

      const files = [];

      if (lite) {
        // Lite mode: no stat calls at all; type comes from the walk entry.
        for (const entry of walkEntries) {
          const isDirectory = entry.isDirectory();

          // Skip directories if not requested
          if (isDirectory && !includeDirs) {
            continue;
          }

          files.push({
            name: entry.name,
            path: path.join(dirPath, entry.relative()),
            type: isDirectory ? 'directory' : 'file'
          });
        }
      } else {
        const stattedEntries = await mapWithBoundedConcurrency(walkEntries, LIST_FILES_STAT_CONCURRENCY, async (entry) => {
          const fullPath = path.join(targetDir, entry.relative());
          const stats = await this._getListablePathStats(fullPath);
          // Entries that disappear between walk and stat are skipped.
          return stats ? { entry, stats } : null;
        });

        for (const statted of stattedEntries) {
          if (!statted) {
            continue;
          }
          const { entry, stats } = statted;
          const isDirectory = stats.isDirectory();

          // Skip directories if not requested
          if (isDirectory && !includeDirs) {
            continue;
          }

          files.push({
            name: entry.name,
            path: path.join(dirPath, entry.relative()),
            type: isDirectory ? 'directory' : 'file',
            size: stats.size,
            mtime: stats.mtime.toISOString(),
          });
        }
      }

      const response = {
        success: true,
        tool: 'list_files',
        dirPath,
        pattern,
        excludePattern: excludePatternString || null, // Report the effective exclusion pattern that was actually applied
        recursive,
        files,
        totalFiles: files.filter(f => f.type === 'file').length,
        totalDirectories: files.filter(f => f.type === 'directory').length,
      };

      if (truncated) {
        response.truncated = true;
        response.totalBeforeTruncation = totalBeforeTruncation;
      }

      return response;
    } catch (error) {
      logger.error(`Error listing files in ${dirPath}: ${error.message}`);
      return {
        success: false,
        tool: 'list_files',
        error: error.message,
        dirPath
      };
    }
  }

  // SEARCH & ANALYSIS TOOLS

  /**
   * Search for files containing a specific pattern
   */
  async searchFiles(projectPath, { searchPattern, dirPath = '', filePattern = '', isRegex = false, useDefaultExclusions = false, customExcludePattern = '' }) {
    try {
      const searchDir = dirPath ? path.join(projectPath, dirPath) : projectPath;
      this.validatePathWithinProject(projectPath, searchDir);
      
      // Determine effective exclude pattern using new logic
      const effectiveExcludePattern = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });
      const excludePatterns = effectiveExcludePattern ? effectiveExcludePattern.split(',').filter(p => p.trim()) : [];
      
      // First, get all files matching the file pattern
      let pattern = filePattern || '**/*';
      
      // Fix: Convert simple patterns like "*.js" to recursive patterns "**/*.js"
      // This ensures filePattern works consistently with the default recursive behavior
      if (filePattern && !filePattern.includes('**') && !filePattern.startsWith('/')) {
        pattern = `**/${filePattern}`;
      }
      
      const files = await glob(pattern, {
        cwd: searchDir,
        nodir: true,
        dot: true,
        ignore: excludePatterns
      });
      
      const results = [];
      const regex = isRegex ? new RegExp(searchPattern) : null;
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const absolutePath = path.join(projectPath, filePath);
        
        try {
          const content = await fsp.readFile(absolutePath, 'utf8');
          const lines = content.split('\n');
          const matches = [];
          
          lines.forEach((line, lineNum) => {
            const isMatch = isRegex 
              ? regex.test(line)
              : line.includes(searchPattern);
            
            if (isMatch) {
              matches.push({
                lineNumber: lineNum + 1,
                line: line.trim(),
                context: {
                  before: lineNum > 0 ? lines[lineNum - 1].trim() : null,
                  after: lineNum < lines.length - 1 ? lines[lineNum + 1].trim() : null
                }
              });
            }
          });
          
          if (matches.length > 0) {
            results.push({
              filePath,
              absolutePath,
              matches,
              totalMatches: matches.length
            });
          }
        } catch (error) {
          logger.debug(`Error reading file ${filePath} during search: ${error.message}`);
          // Skip files that can't be read as text
        }
      }
      
      return {
        success: true,
        tool: 'search_files',
        searchPattern,
        isRegex,
        filePattern,
        dirPath,
        excludePattern: effectiveExcludePattern || null, // Report the effective exclusion pattern that was actually applied
        results,
        totalMatchingFiles: results.length,
        totalMatches: results.reduce((total, file) => total + file.totalMatches, 0)
      };
    } catch (error) {
      logger.error(`Error searching files: ${error.message}`);
      return {
        success: false,
        tool: 'search_files',
        error: error.message
      };
    }
  }

  /**
   * Find files matching specific criteria
   */
  async findFiles(projectPath, { pattern, directoryPath, excludePattern = 'node_modules/**,dist/**,.git/**', maxDepth = 0, useDefaultExclusions = false, customExcludePattern = '' }) {
    try {
      const toolName = 'find_files';
      
      // Handle directoryPath parameter - use it to override projectPath if provided
      const actualProjectPath = directoryPath ? path.join(projectPath, directoryPath) : projectPath;
      
      // Validate that we have a pattern
      if (!pattern) {
        throw new Error('No file pattern provided. Expected "pattern" parameter.');
      }
      
      // Determine effective exclude pattern using helper method
      const excludePatternString = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });
      
      const ignorePatterns = excludePatternString ? excludePatternString.split(',').map(p => p.trim()).filter(p => p) : [];
      
      // Convert simple patterns like "*.js" to recursive patterns "**/*.js"
      // to match the behavior of search_files and user expectations for find_files.
      let globPatternToUse = pattern;
      if (pattern && !pattern.includes('**') && !pattern.startsWith('/') && !pattern.includes('*.*') && pattern.includes('*.')) {
        // Only prepend '**/' if it's a simple extension pattern like '*.js' or '*.ts'
        // and not something more complex like '*.*' or a path-like pattern.
        globPatternToUse = `**/${pattern}`;
        // logger.info(`[DEBUG] findFiles: Converted pattern "${pattern}" to "${globPatternToUse}" for recursion.`);
      }
      
      // Use glob to find files
      const files = await glob(globPatternToUse, {
        cwd: actualProjectPath,
        nodir: true,
        dot: true,
        ignore: ignorePatterns,
        maxDepth: maxDepth > 0 ? maxDepth : undefined
      });
      
      // Ensure files is always an array to prevent "Cannot read properties of undefined (reading 'map')" error
      if (!files || !Array.isArray(files)) {
        return {
          success: true,
          tool: 'find_files',
          pattern,
          excludePattern: excludePatternString || null, // Report the effective exclusion pattern that was actually applied
          files: [],
          totalFiles: 0,
          extensionStats: {},
          warning: `Glob returned ${typeof files} instead of array - no files found`
        };
      }
      
      // Get basic stats for each file - with safety check
      const fileDetails = await Promise.all((files || []).map(async (file) => {
        const filePath = path.join(actualProjectPath, file);
        try {
          const stats = await fsp.stat(filePath);
          return {
            path: file,
            size: stats.size,
            modified: stats.mtime,
            extension: path.extname(file).toLowerCase() || 'no-extension'
          };
        } catch (error) {
          return {
            path: file,
            error: error.message
          };
        }
      }));
      
      // Group by extension for summary
      const extensionStats = {};
      fileDetails.forEach(file => {
        if (file.extension && !file.error) {
          extensionStats[file.extension] = (extensionStats[file.extension] || 0) + 1;
        }
      });
      
      return {
        success: true,
        tool: 'find_files',
        pattern,
        excludePattern: excludePatternString || null, // Report the effective exclusion pattern that was actually applied
        files: fileDetails,
        totalFiles: fileDetails.length,
        extensionStats
      };
    } catch (error) {
      logger.error(`Error finding files: ${error.message}`);
      return {
        success: false,
        tool: 'find_files',
        error: error.message,
        pattern,
        directoryPath
      };
    }
  }

  // GIT OPERATIONS

  /**
   * Get Git repository status
   */
  async gitStatus(projectPath, { showUntracked = true, repoPath } = {}) {
    try {
      // Resolve the effective repository path
      const effectiveRepoPath = repoPath ? path.resolve(projectPath, repoPath) : projectPath;
      
      // Validate that the effective path is within the project
      this.validatePathWithinProject(projectPath, effectiveRepoPath);
      
      if (!await this._isGitRepository(effectiveRepoPath)) {
        return {
          success: false,
          tool: 'git_status',
          error: 'Not a git repository',
          projectPath: effectiveRepoPath
        };
      }
      
      // Get current branch
      const branchResult = await this._executeGitCommand(effectiveRepoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchResult.stdout.trim();
      
      // Get status (porcelain format for easy parsing)
      const statusArgs = ['status', '--porcelain'];
      if (!showUntracked) {
        statusArgs.push('--untracked-files=no');
      }
      const statusResult = await this._executeGitCommand(
        effectiveRepoPath,
        statusArgs
      );
      
      // Parse status output
      const changedFiles = [];
      const lines = statusResult.stdout.split('\n').filter(line => line.trim());
      for (const line of lines) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3);
        
        let changeType = '';
        if (status[0] === 'M') changeType = 'modified';
        else if (status[0] === 'A') changeType = 'added';
        else if (status[0] === 'D') changeType = 'deleted';
        else if (status[0] === 'R') changeType = 'renamed';
        else if (status[0] === 'C') changeType = 'copied';
        else if (status[0] === 'U') changeType = 'unmerged';
        else if (status[0] === '?') changeType = 'untracked';
        
        const staged = status[0] !== ' ' && status[0] !== '?';
        const workingDir = status[1] !== ' ';
        
        changedFiles.push({
          path: filePath,
          status,
          changeType,
          staged,
          workingDir
        });
      }
      
      // Get commit history (last 10 commits)
      const logResult = await this._executeGitCommand(
        effectiveRepoPath,
        ['log', '--max-count=10', '--pretty=format:%h|%an|%ad|%s', '--date=short']
      );
      
      const commits = logResult.stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [hash, author, date, subject] = line.split('|');
          return { hash, author, date, subject };
        });
      
      return {
        success: true,
        tool: 'git_status',
        currentBranch: branch,
        changedFiles,
        commits,
        changedCount: {
          total: changedFiles.length,
          staged: changedFiles.filter(f => f.staged).length,
          unstaged: changedFiles.filter(f => f.workingDir).length,
          untracked: changedFiles.filter(f => f.changeType === 'untracked').length
        }
      };
    } catch (error) {
      logger.error(`Error getting git status: ${error.message}`);
      return {
        success: false,
        tool: 'git_status',
        error: error.message
      };
    }
  }

  /**
   * Get Git diff for various targets
   */
  async gitDiff(projectPath, options = {}) {
    const {
      filePath, fileA, fileB, branch, commitRangeStart, commitRangeEnd,
      staged = false, // This flag is for the general diff case if no specific target is provided
      relativePath = true, // Only relevant if filePath is used
      repoPath
    } = options;

    let commandArgsAttempted = []; // For debugging errors

    try {
      const effectiveRepoPath = repoPath ? path.resolve(projectPath, repoPath) : projectPath;
      this.validatePathWithinProject(projectPath, effectiveRepoPath);

      if (!await this._isGitRepository(effectiveRepoPath)) {
        return {
          success: false,
          tool: 'git_diff',
          error: 'Not a git repository',
          projectPath: effectiveRepoPath,
          optionsProvided: options
        };
      }

      const args = ['diff'];
      commandArgsAttempted = [...args]; // Initialize for error reporting

      let diffTargetDescription = "general unstaged changes"; // Default for 'git diff'

      if (filePath) {
        if (typeof filePath !== 'string') {
          throw new Error(`filePath must be a string. Received: ${typeof filePath}`);
        }
        const absolutePath = path.resolve(effectiveRepoPath, filePath);
        this.validatePathWithinProject(projectPath, absolutePath); // Validates resolved path
        const targetFile = relativePath ? filePath : path.relative(effectiveRepoPath, absolutePath);
        args.push(targetFile);
        diffTargetDescription = `file: ${targetFile}`;
      } else if (fileA && fileB) {
        args.push(fileA, fileB);
        diffTargetDescription = `files: ${fileA} vs ${fileB}`;
      } else if (branch) {
        args.push(branch);
        diffTargetDescription = `branch: ${branch}`;
      } else if (commitRangeStart) {
        if (commitRangeEnd) {
          args.push(`${commitRangeStart}..${commitRangeEnd}`);
          diffTargetDescription = `commits: ${commitRangeStart}..${commitRangeEnd}`;
        } else {
          args.push(commitRangeStart);
          diffTargetDescription = `commit: ${commitRangeStart}`;
        }
      } else {
        // No specific target, this is a general diff
        if (staged) {
          args.push('--staged');
          diffTargetDescription = "general staged changes";
        }
        // else, it's 'git diff' for general unstaged changes, description is already set
      }
      
      commandArgsAttempted = [...args]; // Update with final args before execution
      const diffResult = await this._executeGitCommand(effectiveRepoPath, args);

      return {
        success: true,
        tool: 'git_diff',
        commandUsed: `git ${args.join(' ')}`,
        diffTargetDescription,
        optionsProvided: options,
        diff: diffResult.stdout,
        hasChanges: !!diffResult.stdout.trim()
      };
    } catch (error) {
      logger.error(`Error getting git diff: ${error.message}`, { stack: error.stack, options });
      return {
        success: false,
        tool: 'git_diff',
        error: error.message,
        optionsProvided: options,
        commandArgsAttempted: commandArgsAttempted.length > 0 ? `git ${commandArgsAttempted.join(' ')}` : 'N/A',
        details: error.stack
      };
    }
  }

  // CODE QUALITY & LINTING TOOLS

  /**
   * Format code using Prettier for most languages, Black for Python
   */
  async formatCode(projectPath, params) {
    const { filePath, content = null, parser = 'babel', formatter } = params;
    
    
    try {
      // Get content to format
      let codeToFormat;
      let absolutePath;
      
      if (content !== null) {
        codeToFormat = content;
      } else {
        if (!filePath) {
          return {
            success: false,
            tool: 'format_code',
            error: `No file path provided. Expected filePath parameter. Received: ${JSON.stringify(params)}`,
            params
          };
        }
        
        absolutePath = path.resolve(projectPath, filePath);
        
        this.validatePathWithinProject(projectPath, absolutePath);
        codeToFormat = await fsp.readFile(absolutePath, 'utf8');
      }
      
      // Check if this is a Python file
      const ext = filePath ? path.extname(filePath).toLowerCase() : '';
      if (ext === '.py') {
        return await this._formatPythonWithRuff(projectPath, filePath, codeToFormat, absolutePath, content === null);
      }
      
      // For non-Python files, use Prettier
      // Check if prettier is installed
      let prettier;
      try {
        prettier = require('prettier');
      } catch (error) {
        return {
          success: false,
          tool: 'format_code',
          error: 'Prettier is not installed. Install with: npm install prettier'
        };
      }
      
      // Try to load prettier config from project
      const prettierOptions = await prettier.resolveConfig(projectPath) || {};
      
      // Override parser based on file extension if not explicitly specified
      let actualParser = parser;
      if (!parser && filePath) {
        const parserMap = {
          '.js': 'babel',
          '.jsx': 'babel',
          '.ts': 'typescript',
          '.tsx': 'typescript',
          '.css': 'css',
          '.scss': 'scss',
          '.html': 'html',
          '.vue': 'vue',
          '.json': 'json',
          '.md': 'markdown'
        };
        actualParser = parserMap[ext] || 'babel';
      }
      
      // Format the code
      const formattedCode = await prettier.format(codeToFormat, {
        ...prettierOptions,
        parser: actualParser,
        filepath: filePath // Add filepath to help Prettier infer the correct parser
      });
      
      // If filePath was provided and content was not, write back to file
      if (filePath && content === null) {
        if (!absolutePath) {
          absolutePath = path.resolve(projectPath, filePath);
        }
        await fsp.writeFile(absolutePath, formattedCode);
      }
      
      return {
        success: true,
        tool: 'format_code',
        filePath: filePath,
        formattedCode,
        originalLength: codeToFormat.length,
        formattedLength: formattedCode.length,
        changed: codeToFormat !== formattedCode,
        parser: actualParser,
        formatter: 'prettier'
      };
    } catch (error) {
      return {
        success: false,
        tool: 'format_code',
        error: error.message,
        filePath: filePath,
        debug: {
          originalError: error.message,
          stack: error.stack,
          params: Object.keys(params),
          filePath,
          projectPath
        }
      };
    }
  }

  /**
   * Lint code using ESLint and other linters
   */
  async lintCodeTool(projectPath, params) {
    const { codeContent, languageHint, filePath, useProjectConfig = true, applyFixes = false } = params;
    
    try {
      // Validate required parameters
      if (!codeContent) {
        return {
          success: false,
          tool: 'lint_code',
          error: 'codeContent parameter is required'
        };
      }

      if (!languageHint) {
        return {
          success: false,
          tool: 'lint_code',
          error: 'languageHint parameter is required'
        };
      }

      // When useProjectConfig is false, pass null as projectPath to force default config usage
      // When useProjectConfig is true, pass the actual projectPath for config discovery
      const effectiveProjectPath = useProjectConfig ? projectPath : null;
      
      logger.debug(`lintCodeTool: useProjectConfig=${useProjectConfig}, effectiveProjectPath=${effectiveProjectPath}`);
      
      const result = await lintCode(codeContent, languageHint, filePath, effectiveProjectPath, useProjectConfig, applyFixes);

      return {
        success: result.isSuccess,
        tool: 'lint_code',
        result
      };

    } catch (error) {
      logger.error(`Error in lint_code tool: ${error.message}`);
      return {
        success: false,
        tool: 'lint_code',
        error: error.message
      };
    }
  }

  // ENVIRONMENT & SYSTEM TOOLS

  /**
   * Execute a system command
   */
  async executeCommand(projectPath, { command, workingDir = '', timeout = 30000, shell = true }) {
    try {
      // Resolve the working directory relative to projectPath to get absolute path
      const effectiveCwd = workingDir ? path.resolve(projectPath, workingDir) : projectPath;
      
      // Validate that the effective working directory is within the project for security
      this.validatePathWithinProject(projectPath, effectiveCwd);
      this._assertProtectedExecuteCommandAllowed(effectiveCwd, command);
      
      const result = await this._executeCommandWithTimeout(command, effectiveCwd, timeout, shell);
      
      return {
        success: true,
        tool: 'execute_command',
        toolName: 'Execute Command',
        command,
        workingDir: effectiveCwd, // Return the actual effective working directory used
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        // Include the tool input for display
        toolInput: {
          command,
          workingDir: workingDir || projectPath,
          timeout,
          shell
        },
        // Include metadata for better rendering
        metadata: {
          toolName: 'Execute Command',
          cwd: effectiveCwd,
          duration: result.duration || null,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error(`Error executing command: ${error.message}`);
      return {
        success: false,
        tool: 'execute_command',
        command,
        workingDir: workingDir || '',
        error: error.message,
        ...(error.stdout && { stdout: error.stdout }),
        ...(error.stderr && { stderr: error.stderr })
      };
    }
  }

  /**
   * Fetch a zip payload from Redis (peek without unzipping in chat)
   */
  async fetchZip(_projectPath, { zipId, maxChars = 4000 } = {}) {
    try {
      if (!zipId) {
        return {
          success: false,
          tool: 'fetch_zip',
          error: 'zipId is required'
        };
      }

      await this.ensureRedis();
      const zip = await this.redisService.getZip(zipId);

      if (!zip) {
        return {
          success: false,
          tool: 'fetch_zip',
          zipId,
          error: 'Zip not found'
        };
      }

      const rawContent = typeof zip.content === 'string'
        ? zip.content
        : JSON.stringify(zip.content, null, 2);
      const totalLength = rawContent.length;
      const limit = Number.isFinite(Number(maxChars)) ? Number(maxChars) : 0;
      const shouldTruncate = limit > 0 && rawContent.length > limit;
      const content = shouldTruncate ? rawContent.slice(0, limit) : rawContent;

      return {
        success: true,
        tool: 'fetch_zip',
        zipId,
        truncated: shouldTruncate,
        totalLength,
        content,
        metadata: {
          type: zip.type,
          tokens: zip.tokens,
          name: zip.name,
          description: zip.description,
          source: zip.source,
          ...(zip.metadata ? { metadata: zip.metadata } : {})
        }
      };
    } catch (error) {
      logger.error(`Error fetching zip ${zipId}: ${error.message}`);
      return {
        success: false,
        tool: 'fetch_zip',
        zipId,
        error: error.message
      };
    }
  }

  // HELPER METHODS

  /**
   * Helper: Copy directory recursively
   */
  async _copyDirectory(source, target, recursive) {
    // Create target directory
    await fsp.mkdir(target, { recursive: true });
    
    // Read source directory
    const entries = await fsp.readdir(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      
      if (entry.isDirectory()) {
        if (recursive) {
          await this._copyDirectory(sourcePath, targetPath, recursive);
        }
      } else {
        await fsp.copyFile(sourcePath, targetPath);
      }
    }
  }

  /**
   * Helper: Format Python code using Ruff WASM
   */
  async _formatPythonWithRuff(projectPath, filePath, codeToFormat, absolutePath, writeToFile) {
    try {
      // Ensure Ruff is initialized
      await initializeRuff();
      if (!ruffWasm || !ruffWorkspace) {
        throw new Error('Ruff WASM not initialized.');
      }

      // Format the code using Ruff WASM
      const formattedCode = ruffWorkspace.format(codeToFormat, {
        extension: 'py'
      });

      // Write back to original file if requested
      if (writeToFile && absolutePath) {
        await fsp.writeFile(absolutePath, formattedCode);
      }

      return {
        success: true,
        tool: 'format_code (Ruff)',
        filePath,
        formattedCode,
        originalLength: codeToFormat.length,
        formattedLength: formattedCode.length,
        changed: codeToFormat !== formattedCode,
        parser: 'python',
        formatter: 'ruff'
      };
    } catch (error) {
      logger.error(`Ruff formatting error for ${filePath}: ${error.message}`);
      return {
        success: false,
        tool: 'format_code (Ruff)',
        error: `Ruff formatting failed: ${error.message}`,
        filePath,
        debug: { originalError: error.message, stack: error.stack },
        formatter: 'ruff'
      };
    }
  }

  /**
   * Helper: Guess mime type based on file extension
   */
  _guessMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ts': 'application/typescript',
      '.py': 'text/x-python',
      '.php': 'application/x-php',
      '.rb': 'application/x-ruby',
      '.java': 'text/x-java',
      '.cs': 'text/x-csharp',
      '.c': 'text/x-c',
      '.cpp': 'text/x-c++',
      '.go': 'text/x-go',
      '.rs': 'text/x-rust',
      '.sh': 'application/x-sh',
      '.sql': 'application/sql',
      '.xml': 'application/xml',
      '.csv': 'text/csv',
      '.yml': 'application/yaml',
      '.yaml': 'application/yaml',
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Helper: Check if a file is likely a text file
   */
  _isLikelyTextFile(filePath) {
    const textExtensions = [
      '.txt', '.md', '.js', '.ts', '.json', '.html', '.css', '.scss', '.less',
      '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs',
      '.sh', '.bat', '.ps1', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg',
      '.conf', '.sql', '.graphql', '.jsx', '.tsx', '.vue', '.svelte', '.astro'
    ];
    
    const ext = path.extname(filePath).toLowerCase();
    return textExtensions.includes(ext);
  }

  /**
   * Helper: Check if a directory is a Git repository
   */
  async _isGitRepository(directory) {
    try {
      const gitDirPath = path.join(directory, '.git');
      return fs.existsSync(gitDirPath) && (await fsp.stat(gitDirPath)).isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper: Execute Git command and return stdout/stderr
   */
  async _executeGitCommand(cwd, args) {
    return new Promise((resolve, reject) => {
      const git = spawn('git', args, { cwd });
      
      let stdout = '';
      let stderr = '';
      
      git.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      git.on('error', (err) => {
        reject(new Error(`Failed to execute git command: ${err.message}`));
      });
      
      git.on('close', (code) => {
        if (code !== 0 && stderr) {
          // Allow some commands to return non-zero exit codes with useful stderr
          // e.g., git diff can return 1 if there are differences.
          // For now, let's be strict, but this might need adjustment for specific git commands.
          // If the command is 'diff' and code is 1, it often means changes were found, not an error.
          if (args.includes('diff') && code === 1 && stdout) {
             resolve({ stdout, stderr, code }); // Treat as success if diff found changes
             return;
          }
          reject(new Error(`Git command failed with code ${code}: ${stderr || 'No stderr output'}`));
        } else {
          resolve({ stdout, stderr, code });
        }
      });
    });
  }

  /**
   * Helper: Execute command with timeout
   */
  async _executeCommandWithTimeout(command, cwd, timeout, useShell = true) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      try {
        // For security, we restrict commands to a basic set if not using shell
        // When using shell, command injection risks should be carefully considered
        const childProcess = useShell 
          ? spawn(command, { cwd, shell: true })
          : spawn(command.split(' ')[0], command.split(' ').slice(1), { cwd });
        
        let stdout = '';
        let stderr = '';
        
        childProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        
        childProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        const timeoutId = timeout > 0 
          ? setTimeout(() => {
              childProcess.kill();
              reject(new Error(`Command execution timed out after ${timeout}ms`));
            }, timeout) 
          : null;
        
        childProcess.on('error', (err) => {
          if (timeoutId) clearTimeout(timeoutId);
          reject(new Error(`Failed to execute command: ${err.message}`));
        });
        
        childProcess.on('close', (code) => {
          if (timeoutId) clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          resolve({ stdout, stderr, code, duration });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Validate that a path is within the project directory (security check)
   */
  validatePathWithinProject(projectPath, targetPath) {
    const resolvedProjectPath = path.resolve(projectPath);
    const resolvedTargetPath = path.resolve(targetPath);
    
    if (!resolvedTargetPath.startsWith(resolvedProjectPath)) {
      throw new Error(`Path traversal attempt detected. Path ${targetPath} is outside of project root.`);
    }
  }

  // ANALYSIS TOOLS

  /**
   * Analyze project structure and generate a file tree
   */
  async analyzeStructure(projectPath, { includePattern = '', excludePattern = 'node_modules/**,dist/**,.git/**', maxDepth = 5, useDefaultExclusions = false, customExcludePattern = '' }) {
    try {
      // Determine effective exclude pattern using helper method
      const excludePatternString = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });
      const ignorePatterns = excludePatternString ? excludePatternString.split(',').map(p => p.trim()).filter(p => p) : [];
      const result = {
        success: true,
        tool: 'analyze_structure',
        excludePattern: excludePatternString || null,
        structure: {},
        stats: {
          totalFiles: 0,
          totalDirs: 0,
          filesByType: {},
        }
      };
      
      // Helper to build tree structure
      const buildTree = async (dir, currentDepth = 0) => {
        if (maxDepth > 0 && currentDepth > maxDepth) return null;
        
        const relativePath = path.relative(projectPath, dir);
        const dirName = path.basename(dir) || path.basename(projectPath);
        
        // Check if directory should be excluded using helper method
        if (this._isExcluded(relativePath, ignorePatterns)) {
          return null;
        }
        
        const node = {
          name: dirName,
          type: 'directory',
          path: relativePath || '.',
          children: []
        };
        
        result.stats.totalDirs++;
        
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const entryPath = path.relative(projectPath, fullPath);
          
          // Skip if entry matches exclude pattern using helper method
          if (this._isExcluded(entryPath, ignorePatterns)) {
            continue;
          }
          
          // Include only if it matches include pattern or no pattern specified
          if (includePattern && !minimatch(entryPath, includePattern)) {
            continue;
          }
          
          if (entry.isDirectory()) {
            const subtree = await buildTree(fullPath, currentDepth + 1);
            if (subtree) node.children.push(subtree);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase() || 'no-extension';
            result.stats.filesByType[ext] = (result.stats.filesByType[ext] || 0) + 1;
            result.stats.totalFiles++;
            
            const stats = await fsp.stat(fullPath);
            node.children.push({
              name: entry.name,
              type: 'file',
              path: entryPath,
              size: stats.size,
              extension: ext,
              lastModified: stats.mtime
            });
          }
        }
        
        return node;
      };
      
      result.structure = await buildTree(projectPath);
      
      // Sort children alphabetically with dirs first, then files
      const sortTree = (node) => {
        if (node.children && node.children.length > 0) {
          // Sort directories first, then files, both alphabetically
          node.children.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
          });
          
          // Sort children recursively
          node.children.forEach(child => {
            if (child.type === 'directory') sortTree(child);
          });
        }
        return node;
      };
      
      result.structure = sortTree(result.structure);
      return result;
    } catch (error) {
      logger.error(`Error analyzing project structure: ${error.message}`);
      return {
        success: false,
        tool: 'analyze_structure',
        error: error.message
      };
    }
  }

  /**
   * Count lines of code in the project
   */
  async countLinesOfCode(projectPath, { filePathOrDirectory, includePattern = '**/*.{js,ts,jsx,tsx,html,css,scss,java,py,c,cpp,go,rs}', excludePattern = 'node_modules/**,dist/**,.git/**', useDefaultExclusions = false, customExcludePattern = '' }) {
    try {
      // Determine effective exclude pattern using helper method
      const excludePatternString = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });
      const ignorePatterns = excludePatternString ? excludePatternString.split(',').map(p => p.trim()).filter(p => p) : [];
      
      // Determine scan path - combine projectPath with filePathOrDirectory if provided
      const scanPath = filePathOrDirectory ? path.join(projectPath, filePathOrDirectory) : projectPath;
      
      // Validate that the scan path exists and is within the project
      this.validatePathWithinProject(projectPath, scanPath);
      if (!fs.existsSync(scanPath)) {
        return {
          success: false,
          tool: 'count_lines_of_code',
          error: `Specified path does not exist: ${filePathOrDirectory || 'project root'}`,
          filePathOrDirectory
        };
      }
      
      // Find all files matching the pattern
      const files = await glob(includePattern, {
        cwd: scanPath,
        nodir: true,
        dot: true,
        ignore: ignorePatterns
      });
      
      // Process each file to count lines
      const results = { 
        totalLines: 0, 
        totalFiles: files.length,
        totalBlankLines: 0,
        totalCommentLines: 0,
        totalCodeLines: 0,
        byExtension: {}
      };
      
      for (const file of files) {
        const filePath = path.join(scanPath, file);
        const ext = path.extname(file).toLowerCase() || 'no-extension';
        
        try {
          const content = await fsp.readFile(filePath, 'utf8');
          const lines = content.split('\n');
          
          // Initialize extension stats if needed
          if (!results.byExtension[ext]) {
            results.byExtension[ext] = {
              files: 0,
              lines: 0,
              blankLines: 0,
              commentLines: 0,
              codeLines: 0
            };
          }
          
          results.byExtension[ext].files++;
          
          // Simple comment detection patterns
          const commentPatterns = this._getCommentPatterns(ext);
          let inMultilineComment = false;
          
          for (const line of lines) {
            const trimmedLine = line.trim();
            results.totalLines++;
            results.byExtension[ext].lines++;
            
            // Blank line check
            if (trimmedLine === '') {
              results.totalBlankLines++;
              results.byExtension[ext].blankLines++;
              continue;
            }
            
            // Comment line check - this is a simplified approach
            let isComment = false;
            
            // Check for multiline comments
            if (commentPatterns.multilineStart && commentPatterns.multilineEnd) {
              if (inMultilineComment) {
                isComment = true;
                if (trimmedLine.includes(commentPatterns.multilineEnd)) {
                  inMultilineComment = false;
                }
              } else if (trimmedLine.includes(commentPatterns.multilineStart)) {
                isComment = true;
                if (!trimmedLine.includes(commentPatterns.multilineEnd)) {
                  inMultilineComment = true;
                }
              }
            }
            
            // Check for single line comments
            if (!isComment && commentPatterns.singleLine) {
              for (const pattern of commentPatterns.singleLine) {
                if (trimmedLine.startsWith(pattern)) {
                  isComment = true;
                  break;
                }
              }
            }
            
            if (isComment) {
              results.totalCommentLines++;
              results.byExtension[ext].commentLines++;
            } else {
              results.totalCodeLines++;
              results.byExtension[ext].codeLines++;
            }
          }
        } catch (error) {
          logger.debug(`Error counting lines in ${file}: ${error.message}`);
        }
      }
      
      return {
        success: true,
        tool: 'count_lines_of_code',
        excludePattern: excludePatternString || null,
        results
      };
    } catch (error) {
      logger.error(`Error counting lines of code: ${error.message}`);
      return {
        success: false,
        tool: 'count_lines_of_code',
        error: error.message
      };
    }
  }

  /**
   * Get comment patterns for different file types
   */
  _getCommentPatterns(ext) {
    const patterns = {
      '.js': { singleLine: ['//', '#'], multilineStart: '/*', multilineEnd: '*/' },
      '.jsx': { singleLine: ['//', '#'], multilineStart: '/*', multilineEnd: '*/' },
      '.ts': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.tsx': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.java': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.c': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.cpp': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.cs': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.py': { singleLine: ['#'], multilineStart: '"""', multilineEnd: '"""' },
      '.rb': { singleLine: ['#'], multilineStart: '=begin', multilineEnd: '=end' },
      '.go': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.rs': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' },
      '.php': { singleLine: ['//', '#'], multilineStart: '/*', multilineEnd: '*/' },
      '.sh': { singleLine: ['#'], multilineStart: null, multilineEnd: null },
      '.sql': { singleLine: ['--'], multilineStart: '/*', multilineEnd: '*/' },
      '.html': { singleLine: [], multilineStart: '<!--', multilineEnd: '-->' },
      '.css': { singleLine: [], multilineStart: '/*', multilineEnd: '*/' },
      '.scss': { singleLine: ['//'], multilineStart: '/*', multilineEnd: '*/' }
    };
    
    return patterns[ext] || { singleLine: [], multilineStart: null, multilineEnd: null };
  }

  /**
   * Analyze imports/includes in code files
   */
  async analyzeImports(projectPath, { filePath, filePattern = '**/*.{js,ts,jsx,tsx,py,java,go,rs}', excludePattern = 'node_modules/**,dist/**,.git/**', useDefaultExclusions = false, customExcludePattern = '' }) {
    try {
      // Determine effective exclude pattern using helper method
      const excludePatternString = this._getEffectiveExcludePattern({ useDefaultExclusions, customExcludePattern });
      const ignorePatterns = excludePatternString ? excludePatternString.split(',').map(p => p.trim()).filter(p => p) : [];
      
      // Check if this is single file analysis vs bulk analysis
      let actualFilePattern = filePattern;
      let isSingleFileAnalysis = false;
      
      if (filePath) {
        // Single file analysis - override the pattern to target just this file
        actualFilePattern = filePath;
        isSingleFileAnalysis = true;
      }
      
      // Find files matching the pattern
      const files = await glob(actualFilePattern, {
        cwd: projectPath,
        nodir: true,
        dot: true,
        ignore: ignorePatterns
      });
      
      const results = {
        fileCount: files.length,
        imports: {},
        files: []
      };
      
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const ext = path.extname(file).toLowerCase();
        
        try {
          const content = await fsp.readFile(filePath, 'utf8');
          const fileImports = this._extractImports(content, ext);
          
          if (fileImports.length > 0) {
            results.files.push({
              path: file,
              imports: fileImports
            });
            
            // Count occurrences of each import
            fileImports.forEach(imp => {
              results.imports[imp] = (results.imports[imp] || 0) + 1;
            });
          }
        } catch (error) {
          logger.debug(`Error analyzing imports in ${file}: ${error.message}`);
        }
      }
      
      // Sort imports by frequency
      results.mostUsed = Object.entries(results.imports)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([imp, count]) => ({ import: imp, count }));
      
      return {
        success: true,
        tool: 'analyze_imports',
        excludePattern: excludePatternString || null,
        results
      };
    } catch (error) {
      logger.error(`Error analyzing imports: ${error.message}`);
      return {
        success: false,
        tool: 'analyze_imports',
        error: error.message
      };
    }
  }

  /**
   * Extract imports from file content based on language
   */
  _extractImports(content, ext) {
    const imports = [];
    const lines = content.split('\n');
    
    const patterns = {
      '.js': [/^import\s+.*from\s+['"](.+)['"]/i, /^const\s+.*=\s*require\(['"](.+)['"]\)/i],
      '.jsx': [/^import\s+.*from\s+['"](.+)['"]/i, /^const\s+.*=\s*require\(['"](.+)['"]\)/i],
      '.ts': [/^import\s+.*from\s+['"](.+)['"]/i],
      '.tsx': [/^import\s+.*from\s+['"](.+)['"]/i],
      '.py': [/^import\s+(\S+)/i, /^from\s+(\S+)\s+import/i],
      '.java': [/^import\s+(\S+);/i],
      '.go': [/^import\s+"(.+)"/i, /^import\s+\(/i],
      '.rs': [/^use\s+(\S+);/i, /^extern\s+crate\s+(\S+);/i]
    };
    
    const filePatterns = patterns[ext] || [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      for (const pattern of filePatterns) {
        const match = trimmedLine.match(pattern);
        if (match && match[1]) {
          imports.push(match[1]);
        }
      }
    }
    
    return [...new Set(imports)]; // Remove duplicates
  }

  /**
   * Analyze project dependencies
   */
  async analyzeDependencies(projectPath, { packageManager = 'auto' }) {
    try {
      let manager = packageManager;
      
      // Auto-detect package manager if needed
      if (manager === 'auto') {
        manager = await this.detectPackageManager(projectPath);
        if (!manager) {
          return {
            success: false,
            tool: 'analyze_dependencies',
            error: 'Could not detect package manager. No package.json, requirements.txt, or other dependency files found.'
          };
        }
      }
      
      const results = {
        packageManager: manager,
        dependencies: {},
        devDependencies: {},
        totalDependencies: 0,
        totalDevDependencies: 0
      };
      
      switch (manager) {
        case 'npm':
        case 'yarn':
        case 'pnpm': {
          const packageJsonPath = path.join(projectPath, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8'));
            results.dependencies = packageJson.dependencies || {};
            results.devDependencies = packageJson.devDependencies || {};
            results.totalDependencies = Object.keys(results.dependencies).length;
            results.totalDevDependencies = Object.keys(results.devDependencies).length;
            results.name = packageJson.name;
            results.version = packageJson.version;
          }
          break;
        }
        case 'pip': {
          const requirementsPath = path.join(projectPath, 'requirements.txt');
          if (fs.existsSync(requirementsPath)) {
            const content = await fsp.readFile(requirementsPath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));
            lines.forEach(line => {
              const [pkg, version] = line.split(/[=<>]/);
              if (pkg) {
                results.dependencies[pkg.trim()] = version ? version.trim() : '*';
              }
            });
            results.totalDependencies = Object.keys(results.dependencies).length;
          }
          break;
        }
        case 'poetry': {
          const pyprojectPath = path.join(projectPath, 'pyproject.toml');
          if (fs.existsSync(pyprojectPath)) {
            const toml = require('toml');
            const content = await fsp.readFile(pyprojectPath, 'utf8');
            const parsed = toml.parse(content);
            if (parsed.tool && parsed.tool.poetry) {
              results.dependencies = parsed.tool.poetry.dependencies || {};
              results.devDependencies = parsed.tool.poetry['dev-dependencies'] || {};
              results.totalDependencies = Object.keys(results.dependencies).length;
              results.totalDevDependencies = Object.keys(results.devDependencies).length;
              results.name = parsed.tool.poetry.name;
              results.version = parsed.tool.poetry.version;
            }
          }
          break;
        }
      }
      
      return {
        success: true,
        tool: 'analyze_dependencies',
        results
      };
    } catch (error) {
      logger.error(`Error analyzing dependencies: ${error.message}`);
      return {
        success: false,
        tool: 'analyze_dependencies',
        error: error.message
      };
    }
  }

  /**
   * Detect package manager based on lock files and config files
   */
  async detectPackageManager(projectPath) {
    const checks = [
      { file: 'package-lock.json', manager: 'npm' },
      { file: 'yarn.lock', manager: 'yarn' },
      { file: 'pnpm-lock.yaml', manager: 'pnpm' },
      { file: 'requirements.txt', manager: 'pip' },
      { file: 'Pipfile', manager: 'pipenv' },
      { file: 'pyproject.toml', manager: 'poetry' },
      { file: 'go.mod', manager: 'go' },
      { file: 'Cargo.toml', manager: 'cargo' },
      { file: 'composer.json', manager: 'composer' },
      { file: 'Gemfile', manager: 'bundler' }
    ];
    
    for (const check of checks) {
      if (fs.existsSync(path.join(projectPath, check.file))) {
        return check.manager;
      }
    }
    
    // Check for package.json without lock file
    if (fs.existsSync(path.join(projectPath, 'package.json'))) {
      return 'npm';
    }
    
    return null;
  }

  /**
   * Basic syntax validation for code files
   */
  async validateSyntax(projectPath, { filePath, content = null, language = null }) {
    try {
      // Determine language from file extension if not specified
      if (!language && filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const languageMap = {
          '.js': 'javascript',
          '.jsx': 'javascript',
          '.ts': 'typescript',
          '.tsx': 'typescript',
          '.py': 'python',
          '.rb': 'ruby',
          '.java': 'java',
          '.php': 'php',
          '.go': 'go',
          '.json': 'json',
          '.html': 'html',
          '.css': 'css'
        };
        language = languageMap[ext] || null;
      }
      
      if (!language) {
        return {
          success: false,
          tool: 'validate_syntax',
          error: 'Could not determine language for syntax validation',
          filePath
        };
      }
      
      // Get content to validate
      let codeToValidate;
      if (content !== null) {
        codeToValidate = content;
      } else {
        const absolutePath = path.resolve(projectPath, filePath);
        this.validatePathWithinProject(projectPath, absolutePath);
        codeToValidate = await fsp.readFile(absolutePath, 'utf8');
      }
      
      // Perform validation based on language
      let validationResult;
      
      switch (language) {
        case 'javascript':
          validationResult = await this._validateJavaScript(codeToValidate);
          break;
        case 'json':
          validationResult = await this._validateJSON(codeToValidate);
          break;
        case 'python':
          validationResult = await this._validateWithCommand('python', ['-c', 'import sys, ast; ast.parse(sys.stdin.read())'], codeToValidate);
          break;
        default:
          return {
            success: false,
            tool: 'validate_syntax',
            error: `Syntax validation not implemented for ${language}`,
            filePath,
            language
          };
      }
      
      return {
        success: true,
        tool: 'validate_syntax',
        filePath,
        language,
        ...validationResult
      };
    } catch (error) {
      logger.error(`Error validating syntax: ${error.message}`);
      return {
        success: false,
        tool: 'validate_syntax',
        error: error.message,
        filePath,
        language
      };
    }
  }

  /**
   * Helper: Validate JavaScript/TypeScript syntax
   */
  async _validateJavaScript(code) {
    try {
      // Basic check using Function constructor
      new Function(code);
      return { valid: true, errors: [] };
    } catch (error) {
      return {
        valid: false,
        errors: [{
          line: error.lineNumber || 0,
          column: error.columnNumber || 0,
          message: error.message
        }]
      };
    }
  }

  /**
   * Helper: Validate JSON syntax
   */
  async _validateJSON(code) {
    try {
      JSON.parse(code);
      return { valid: true, errors: [] };
    } catch (error) {
      // Try to extract line number from error message
      const match = error.message.match(/position (\d+)/);
      const position = match ? parseInt(match[1]) : 0;
      
      // Rough line number calculation
      let line = 1;
      let charCount = 0;
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1; // +1 for newline
        if (charCount >= position) {
          line = i + 1;
          break;
        }
      }
      
      return {
        valid: false,
        errors: [{
          line,
          column: 0,
          message: error.message
        }]
      };
    }
  }

  /**
   * Helper: Validate using external command
   */
  async _validateWithCommand(command, args, code) {
    try {
      const result = await this._executeCommandWithTimeout(
        `${command} ${args.join(' ')}`,
        process.cwd(),
        5000,
        false
      );
      
      // For Python, we need to pipe the code through stdin
      // This is a simplified version - in production you'd use child_process.spawn with stdin
      if (result.code === 0) {
        return { valid: true, errors: [] };
      } else {
        return {
          valid: false,
          errors: [{
            line: 0,
            column: 0,
            message: result.stderr || 'Syntax error'
          }]
        };
      }
    } catch (error) {
      return {
        valid: false,
        errors: [{
          line: 0,
          column: 0,
          message: error.message
        }]
      };
    }
  }

  /**
   * Get system environment information
   */
  async getEnvironmentInfo(projectPath) {
    try {
      // Get Node.js info
      const nodeVersion = process.version;
      const npmVersion = await this._getCommandOutput('npm --version', projectPath);
      
      // Get OS info
      const osInfo = {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem()
      };
      
      // Get project-specific environment
      const envVars = process.env;
      const filteredEnvVars = {
        // Include only safe environment variables that don't contain secrets
        NODE_ENV: envVars.NODE_ENV,
        PATH: envVars.PATH,
        LANG: envVars.LANG,
        PWD: envVars.PWD,
        HOME: envVars.HOME,
        USER: envVars.USER,
        SHELL: envVars.SHELL,
      };
      
      // Check for .env files
      const hasEnvFile = fs.existsSync(path.join(projectPath, '.env'));
      const hasEnvDevelopment = fs.existsSync(path.join(projectPath, '.env.development'));
      const hasEnvProduction = fs.existsSync(path.join(projectPath, '.env.production'));
      
      // Get tool versions commonly used in development
      const toolVersions = {};
      const toolCommands = {
        git: 'git --version',
        python: 'python --version',
        python3: 'python3 --version',
        java: 'java -version',
        gcc: 'gcc --version',
        docker: 'docker --version',
        yarn: 'yarn --version',
        pnpm: 'pnpm --version',
        mvn: 'mvn --version',
        gradle: 'gradle --version'
      };
      
      for (const [tool, cmd] of Object.entries(toolCommands)) {
        try {
          const version = await this._getCommandOutput(cmd, projectPath);
          if (version) toolVersions[tool] = version.trim();
        } catch {
          // Skip if tool is not available
        }
      }
      
      return {
        success: true,
        tool: 'get_environment_info',
        node: {
          version: nodeVersion,
          npm: npmVersion?.trim() || 'Not found'
        },
        os: osInfo,
        env: filteredEnvVars,
        envFiles: {
          '.env': hasEnvFile,
          '.env.development': hasEnvDevelopment,
          '.env.production': hasEnvProduction
        },
        tools: toolVersions
      };
    } catch (error) {
      logger.error(`Error getting environment info: ${error.message}`);
      return {
        success: false,
        tool: 'get_environment_info',
        error: error.message
      };
    }
  }

  /**
   * Check if certain tools/dependencies are installed
   */
  async checkInstallation(projectPath, { tools = [] }) {
    try {
      // Parse the tools parameter into an array of tool names
      let parsedTools = [];
      
      if (Array.isArray(tools)) {
        parsedTools = tools;
      } else if (typeof tools === 'string') {
        const trimmedTools = tools.trim();
        
        if (trimmedTools === '') {
          parsedTools = [];
        } else if (trimmedTools.startsWith('[') && trimmedTools.endsWith(']')) {
          try {
            parsedTools = JSON.parse(trimmedTools);
            if (!Array.isArray(parsedTools)) {
              throw new Error('Parsed JSON is not an array');
            }
          } catch (jsonError) {
            parsedTools = trimmedTools.split(',').map(t => t.trim()).filter(t => t.length > 0);
          }
        } else if (trimmedTools.includes(',')) {
          parsedTools = trimmedTools.split(',').map(t => t.trim()).filter(t => t.length > 0);
        } else {
          parsedTools = [trimmedTools];
        }
      } else {
        parsedTools = [];
      }
      
      const results = {};
      
      for (const tool of parsedTools) {
        let command = tool;
        let versionFlag = '--version';
        
        // Special cases for tools with different version flags
        if (tool === 'java') versionFlag = '-version';
        if (tool === 'python3') command = 'python3';
        
        try {
          const { stdout, stderr, code } = await this._executeCommandWithTimeout(
            `${command} ${versionFlag}`, 
            projectPath, 
            5000
          );
          
          const output = stdout || stderr;
          results[tool] = {
            installed: code === 0,
            version: output ? output.trim().split('\n')[0] : 'Unknown',
            exitCode: code
          };
        } catch (error) {
          results[tool] = {
            installed: false,
            error: error.message
          };
        }
      }
      
      return {
        success: true,
        tool: 'check_installation',
        results
      };
    } catch (error) {
      logger.error(`Error checking installations: ${error.message}`);
      return {
        success: false,
        tool: 'check_installation',
        error: error.message
      };
    }
  }

  /**
   * Get Git branch information
   */
  async gitBranches(projectPath, { repoPath } = {}) {
    try {
      // Resolve the effective repository path
      const effectiveRepoPath = repoPath ? path.resolve(projectPath, repoPath) : projectPath;
      
      // Validate that the effective path is within the project
      this.validatePathWithinProject(projectPath, effectiveRepoPath);
      
      // Check if the effective path is a Git repository
      if (!await this._isGitRepository(effectiveRepoPath)) {
        return {
          success: false,
          tool: 'git_branches',
          error: 'Not a git repository',
          projectPath: effectiveRepoPath
        };
      }
      
      // Get current branch
      const currentBranchResult = await this._executeGitCommand(effectiveRepoPath,
        ['rev-parse', '--abbrev-ref', 'HEAD']
      );
      const currentBranch = currentBranchResult.stdout.trim();
      
      // Get all branches
      const branchesResult = await this._executeGitCommand(effectiveRepoPath,
        ['branch', '--list', '--all', '--format=%(refname:short)|%(objectname:short)|%(committerdate:short)']
      );
      
      const branches = branchesResult.stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [name, commit, date] = line.split('|');
          // Fix: Correctly identify remote-tracking branches
          const isRemote = name.startsWith('remotes/') || (name.includes('/') && !name.startsWith('HEAD'));
          const isHead = name === currentBranch;
          
          return {
            name,
            commit,
            date,
            isRemote,
            isHead
          };
        });
      
      return {
        success: true,
        tool: 'git_branches',
        currentBranch,
        branches,
        localBranches: branches.filter(b => !b.isRemote),
        remoteBranches: branches.filter(b => b.isRemote)
      };
    } catch (error) {
      logger.error(`Error getting git branches: ${error.message}`);
      return {
        success: false,
        tool: 'git_branches',
        error: error.message
      };
    }
  }

  /**
   * Helper: Get command output
   */
  async _getCommandOutput(command, cwd) {
    try {
      const result = await this._executeCommandWithTimeout(command, cwd, 5000);
      return result.stdout;
    } catch {
      return null;
    }
  }

  // ===== ARTIFACTS (Redis-backed, aligns with Batshit ArtifactRecord) =====

  _artifactKey(id) {
    return `artifact:${id}`;
  }

  _artifactSetKey(userId) {
    return `user:${userId}:artifacts`;
  }

  _now() {
    return new Date().toISOString();
  }

  async _getArtifact(id) {
    await this.ensureRedis();
    return await this.redisService.client.json.get(this._artifactKey(id));
  }

  async artifactCreate(projectPath, params) {
    await this.ensureRedis();
    const {
      userId,
      name = 'Untitled Artifact',
      type = 'html',
      content = '',
      mode = 'edit',
      description = '',
      tags = [],
      metadata = {},
      sessionId = '',
      ai_enabled = false,
      webhook_url = null,
      custom_prompt = null,
      zone = null
    } = params;

    if (!userId) {
      throw new Error('userId is required');
    }

    const now = this._now();
    const artifactId = `artifact_${nanoid()}`;
    const versionEntry = {
      id: `v1_${nanoid()}`,
      version: 1,
      content,
      description: 'Initial version',
      created_at: now,
      created_by: userId
    };

    const record = {
      id: artifactId,
      user_id: userId,
      name,
      type,
      content,
      mode,
      version: 1,
      description,
      tags,
      metadata,
      created_in_session: sessionId,
      last_edited_session: sessionId,
      ai_enabled,
      webhook_url,
      custom_prompt,
      zone,
      created_at: now,
      updated_at: now,
      published_at: null,
      versions: [versionEntry]
    };

    const client = this.redisService.client;
    await client.json.set(this._artifactKey(artifactId), '$', record);
    await client.sAdd(this._artifactSetKey(userId), artifactId);

    return { success: true, artifact: record };
  }

  async artifactList(projectPath, { userId }) {
    await this.ensureRedis();
    if (!userId) throw new Error('userId is required');

    const client = this.redisService.client;
    const ids = await client.sMembers(this._artifactSetKey(userId));
    const artifacts = [];
    for (const id of ids) {
      const art = await client.json.get(this._artifactKey(id));
      if (art) artifacts.push(art);
    }

    artifacts.sort((a, b) => {
      const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
      const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });

    return { success: true, artifacts };
  }

  async artifactGet(projectPath, { artifactId, userId }) {
    await this.ensureRedis();
    if (!artifactId || !userId) throw new Error('artifactId and userId are required');

    const art = await this._getArtifact(artifactId);
    if (!art) throw new Error('Artifact not found');
    const owner = art.user_id || art.userId;
    if (owner !== userId && art.mode !== 'published') throw new Error('Access denied');
    return { success: true, artifact: art };
  }

  async artifactUpdate(projectPath, params) {
    await this.ensureRedis();
    const { artifactId, userId, versionDescription, sessionId, ...updates } = params;
    if (!artifactId || !userId) throw new Error('artifactId and userId are required');

    const client = this.redisService.client;
    const existing = await this._getArtifact(artifactId);
    if (!existing) throw new Error('Artifact not found');
    const owner = existing.user_id || existing.userId;
    if (owner !== userId) throw new Error('Access denied');

    const now = this._now();
    let versions = existing.versions || [];
    let nextVersion = existing.version || 1;

    if (updates.content !== undefined && updates.content !== existing.content) {
      nextVersion = nextVersion + 1;
      versions = [
        ...versions,
        {
          id: `v${nextVersion}_${nanoid()}`,
          version: nextVersion,
          content: updates.content,
          description: versionDescription || `Updated on ${new Date().toLocaleDateString()}`,
          created_at: now,
          created_by: userId
        }
      ];
    }

    const publishedNow = updates.mode === 'published' && existing.mode !== 'published';

    const updated = {
      ...existing,
      ...updates,
      version: nextVersion,
      versions,
      last_edited_session: sessionId || existing.last_edited_session,
      updated_at: now,
      published_at: publishedNow ? now : existing.published_at || null
    };

    await client.json.set(this._artifactKey(artifactId), '$', updated);
    return { success: true, artifact: updated };
  }

  async artifactPublish(projectPath, { artifactId, userId, publish = true }) {
    return await this.artifactUpdate(projectPath, {
      artifactId,
      userId,
      mode: publish ? 'published' : 'edit'
    });
  }

  async artifactAddVersion(projectPath, { artifactId, userId, content, description }) {
    if (!content) throw new Error('content is required');
    return await this.artifactUpdate(projectPath, {
      artifactId,
      userId,
      content,
      versionDescription: description
    });
  }

  async artifactRollback(projectPath, { artifactId, userId, targetVersion }) {
    await this.ensureRedis();
    if (!artifactId || !userId || targetVersion === undefined) throw new Error('artifactId, userId, targetVersion required');

    const artifact = await this._getArtifact(artifactId);
    if (!artifact) throw new Error('Artifact not found');
    const owner = artifact.user_id || artifact.userId;
    if (owner !== userId) throw new Error('Access denied');

    const match = (artifact.versions || []).find(v => v.version === Number(targetVersion));
    if (!match) throw new Error('Target version not found');

    return await this.artifactAddVersion(projectPath, {
      artifactId,
      userId,
      content: match.content,
      description: `Restored from version ${targetVersion}`
    });
  }

  async artifactDeleteVersion(projectPath, { artifactId, userId, version }) {
    await this.ensureRedis();
    const client = this.redisService.client;
    if (!artifactId || !userId || version === undefined) throw new Error('artifactId, userId, version required');

    const artifact = await this._getArtifact(artifactId);
    if (!artifact) throw new Error('Artifact not found');
    const owner = artifact.user_id || artifact.userId;
    if (owner !== userId) throw new Error('Access denied');

    const currentVersion = artifact.version || 1;
    if (Number(version) === currentVersion) throw new Error('Cannot delete current version');

    const remaining = (artifact.versions || []).filter(v => v.version !== Number(version));
    if (remaining.length === 0) throw new Error('Cannot delete the only version');

    const updated = {
      ...artifact,
      versions: remaining,
      updated_at: this._now()
    };

    await client.json.set(this._artifactKey(artifactId), '$', updated);
    return { success: true, artifact: updated };
  }

  async artifactSetWebhook(projectPath, { artifactId, userId, webhook_url, ai_enabled }) {
    return await this.artifactUpdate(projectPath, {
      artifactId,
      userId,
      webhook_url: webhook_url ?? null,
      ai_enabled
    });
  }

  async artifactSetZone(projectPath, { artifactId, userId, zone }) {
    return await this.artifactUpdate(projectPath, {
      artifactId,
      userId,
      zone: zone || null
    });
  }

  async artifactUse(projectPath, params) {
    await this.ensureRedis();
    const {
      userId,
      artifactId,
      prompt,
      context = null,
      mode = 'complete',
      transport = 'auto',
      sessionId,
      model,
      webhook_url
    } = params;

    if (!userId || !artifactId || !prompt) {
      throw new Error('userId, artifactId, and prompt are required');
    }

    const artifact = await this._getArtifact(artifactId);
    if (!artifact) throw new Error('Artifact not found');
    const owner = artifact.user_id || artifact.userId;
    if (owner !== userId && artifact.mode !== 'published') {
      throw new Error('Access denied');
    }

    const chosenTransport = (transport === 'webhook') ||
      ((transport === 'auto' || !transport) && (webhook_url || artifact.webhook_url))
        ? 'webhook'
        : 'mode3';

    if (chosenTransport === 'webhook') {
      const url = webhook_url || artifact.webhook_url;
      if (!url) throw new Error('No webhook configured for this artifact');

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId, prompt, context, mode, sessionId: sessionId || `artifact:${artifactId}:${userId}` })
      });

      if (!response.ok) {
        const msg = await response.text().catch(() => '');
        throw new Error(`Webhook failed (${response.status}): ${msg}`);
      }

      const data = await response.json().catch(() => null);
      const text = data?.text || data?.response || data?.result || (typeof data === 'string' ? data : JSON.stringify(data, null, 2));

      return {
        success: true,
        transport: 'webhook',
        text,
        data,
        artifactId
      };
    }

    const completeUrl = process.env.BATSHIT_ARTIFACT_COMPLETE_URL || 'http://localhost:5620/api/artifacts/complete';
    const token = process.env.BATSHIT_TOKEN || process.env.MCP_GATEWAY_AUTH_TOKEN || '';

    const resp = await fetch(completeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-batshit-token': token } : {})
      },
      body: JSON.stringify({
        artifactId,
        prompt,
        context,
        mode,
        transport: 'mode3',
        sessionId: sessionId || `artifact:${artifactId}:${userId}`,
        model: model || artifact.model || null,
        userId
      })
    });

    if (!resp.ok || !resp.body) {
      const msg = await resp.text().catch(() => '');
      throw new Error(`artifact_use failed (${resp.status}): ${msg || 'no body'}`);
    }

    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = '';
    let aggregated = '';
    let usage;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (err) {
          continue;
        }

        const type = evt.type || evt.event || evt.kind;
        if (type === 'chunk') {
          aggregated += evt.content || '';
        } else if (type === 'finish') {
          if (evt.content) aggregated += evt.content;
          usage = evt.usage || evt.metadata?.usage || usage;
        } else if (type === 'end' && evt.metadata?.usage) {
          usage = evt.metadata.usage;
        } else if (type === 'error') {
          throw new Error(evt.error || 'Artifact completion failed');
        }
      }
    }

    aggregated = aggregated.trim();

    return {
      success: true,
      transport: 'mode3',
      text: aggregated,
      usage,
      artifactId,
      model: model || artifact.model,
      mode
    };
  }

  /**
   * Analyze a URL to understand what type of external source it is and extract metadata.
   * Helps the PA make informed decisions about how to build an artifact from external sources.
   */
  async artifactAnalyzeUrl(projectPath, params) {
    const { url, hfToken, githubToken } = params;

    if (!url) {
      throw new Error('URL is required');
    }

    const analysis = {
      sourceType: 'unknown',
      url,
      analyzed: true,
      analyzedAt: new Date().toISOString(),

      // HuggingFace/Gradio specific
      sdkType: null,
      spaceName: null,
      spaceAuthor: null,
      spaceDescription: null,
      gradioEndpoints: [],

      // GitHub specific
      repoName: null,
      repoOwner: null,
      repoDescription: null,
      hasDockerfile: false,
      hasPythonDeps: false,
      hasNodeDeps: false,
      readmeSummary: null,

      // UI elements detected
      detectedInputs: [],
      detectedOutputs: [],

      // Recommendations
      recommendedApproach: null,
      recommendationReason: null,
      requiresToken: false,
      tokenType: null,
      estimatedDependencies: [],

      // Raw metadata
      rawMetadata: {}
    };

    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      // Detect source type from URL
      if (hostname === 'huggingface.co' || hostname === 'www.huggingface.co') {
        return await this._analyzeHuggingFaceUrl(url, hfToken, analysis);
      } else if (hostname === 'github.com' || hostname === 'www.github.com') {
        return await this._analyzeGitHubUrl(url, githubToken, analysis);
      } else if (hostname.includes('hf.space') || hostname.includes('gradio')) {
        // Standalone Gradio app or HF Space subdomain
        return await this._analyzeGradioUrl(url, hfToken, analysis);
      } else {
        // Unknown source - try to detect if it's a Gradio app
        return await this._analyzeUnknownUrl(url, analysis);
      }
    } catch (error) {
      logger.error(`[artifactAnalyzeUrl] Error analyzing ${url}:`, error);
      analysis.error = error.message;
      analysis.recommendedApproach = 'manual';
      analysis.recommendationReason = `Could not analyze URL: ${error.message}`;
      return analysis;
    }
  }

  async _analyzeHuggingFaceUrl(url, hfToken, analysis) {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

    // Check if it's a Space (e.g., /spaces/author/name)
    if (pathParts[0] === 'spaces' && pathParts.length >= 3) {
      analysis.sourceType = 'hf_space';
      analysis.spaceAuthor = pathParts[1];
      analysis.spaceName = pathParts[2];

      // Fetch Space metadata from HuggingFace API
      const headers = {};
      if (hfToken) {
        headers['Authorization'] = `Bearer ${hfToken}`;
      }

      try {
        const apiUrl = `https://huggingface.co/api/spaces/${analysis.spaceAuthor}/${analysis.spaceName}`;
        const resp = await fetch(apiUrl, { headers });

        if (resp.ok) {
          const data = await resp.json();
          analysis.rawMetadata.hfApi = data;
          analysis.spaceDescription = data.cardData?.short_description || data.description || null;
          analysis.sdkType = data.sdk || null;

          // Determine recommended approach based on SDK
          if (analysis.sdkType === 'gradio') {
            analysis.recommendedApproach = 'api';
            analysis.recommendationReason = 'Gradio SDK detected - can use @gradio/client JavaScript API without installation';
            analysis.requiresToken = data.private || false;
            analysis.tokenType = analysis.requiresToken ? 'hf' : null;

            // Try to fetch Gradio API info
            const gradioApiUrl = `https://${analysis.spaceAuthor}-${analysis.spaceName}.hf.space/info`;
            try {
              const gradioResp = await fetch(gradioApiUrl, { headers });
              if (gradioResp.ok) {
                const gradioInfo = await gradioResp.json();
                analysis.rawMetadata.gradioInfo = gradioInfo;

                // Extract endpoint info
                if (gradioInfo.api) {
                  analysis.gradioEndpoints = Object.entries(gradioInfo.api).map(([name, info]) => ({
                    name,
                    inputs: info.parameters?.map(p => p.label || p.parameter_name) || [],
                    outputs: info.returns?.map(r => r.label || r.type) || []
                  }));
                }
              }
            } catch (e) {
              // Gradio info endpoint might not be available
              logger.debug(`Could not fetch Gradio info: ${e.message}`);
            }
          } else if (analysis.sdkType === 'streamlit') {
            analysis.recommendedApproach = 'docker';
            analysis.recommendationReason = 'Streamlit SDK requires running the app - Docker recommended';
            analysis.estimatedDependencies = ['python', 'streamlit'];
          } else if (analysis.sdkType === 'docker') {
            analysis.recommendedApproach = 'docker';
            analysis.recommendationReason = 'Docker-based Space - use Docker to run locally';
          } else {
            analysis.recommendedApproach = 'recreate';
            analysis.recommendationReason = `Unknown SDK type (${analysis.sdkType}) - consider recreating functionality with fresh code`;
          }
        } else if (resp.status === 401 || resp.status === 403) {
          analysis.requiresToken = true;
          analysis.tokenType = 'hf';
          analysis.recommendedApproach = 'api';
          analysis.recommendationReason = 'Private Space - requires HF_TOKEN to access';
        }
      } catch (e) {
        logger.error(`[_analyzeHuggingFaceUrl] API fetch error: ${e.message}`);
      }
    } else {
      // It's a model/dataset page, not a Space
      analysis.sourceType = 'hf_other';
      analysis.recommendedApproach = 'manual';
      analysis.recommendationReason = 'This appears to be a HuggingFace model/dataset page, not a Space. Consider finding an associated Space or building a custom interface.';
    }

    return analysis;
  }

  async _analyzeGitHubUrl(url, githubToken, analysis) {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

    if (pathParts.length >= 2) {
      analysis.sourceType = 'github';
      analysis.repoOwner = pathParts[0];
      analysis.repoName = pathParts[1];

      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'batshit-server'
      };
      if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`;
      }

      try {
        // Fetch repo metadata
        const repoUrl = `https://api.github.com/repos/${analysis.repoOwner}/${analysis.repoName}`;
        const resp = await fetch(repoUrl, { headers });

        if (resp.ok) {
          const data = await resp.json();
          analysis.rawMetadata.githubRepo = data;
          analysis.repoDescription = data.description || null;

          // Check for key files
          const contentsUrl = `https://api.github.com/repos/${analysis.repoOwner}/${analysis.repoName}/contents`;
          const contentsResp = await fetch(contentsUrl, { headers });

          if (contentsResp.ok) {
            const contents = await contentsResp.json();
            const fileNames = contents.map(f => f.name.toLowerCase());

            analysis.hasDockerfile = fileNames.includes('dockerfile');
            analysis.hasPythonDeps = fileNames.includes('requirements.txt') || fileNames.includes('pyproject.toml') || fileNames.includes('setup.py');
            analysis.hasNodeDeps = fileNames.includes('package.json');

            // Try to get README
            const readmeFile = contents.find(f => f.name.toLowerCase().startsWith('readme'));
            if (readmeFile) {
              try {
                const readmeResp = await fetch(readmeFile.download_url);
                if (readmeResp.ok) {
                  const readmeContent = await readmeResp.text();
                  analysis.readmeSummary = readmeContent.substring(0, 800) + (readmeContent.length > 800 ? '...' : '');
                }
              } catch (e) {
                // README fetch failed
              }
            }
          }

          // Determine recommended approach
          if (analysis.hasDockerfile) {
            analysis.recommendedApproach = 'docker';
            analysis.recommendationReason = 'Dockerfile found - Docker installation recommended';
            analysis.estimatedDependencies = ['docker'];
          } else if (analysis.hasPythonDeps) {
            analysis.recommendedApproach = 'local';
            analysis.recommendationReason = 'Python project detected - clone and set up virtual environment';
            analysis.estimatedDependencies = ['python', 'pip'];
          } else if (analysis.hasNodeDeps) {
            analysis.recommendedApproach = 'local';
            analysis.recommendationReason = 'Node.js project detected - clone and npm install';
            analysis.estimatedDependencies = ['node', 'npm'];
          } else {
            analysis.recommendedApproach = 'recreate';
            analysis.recommendationReason = 'No standard build system detected - consider recreating functionality';
          }
        } else if (resp.status === 401 || resp.status === 403) {
          analysis.requiresToken = true;
          analysis.tokenType = 'github';
          analysis.recommendedApproach = 'local';
          analysis.recommendationReason = 'Private repo - requires GITHUB_TOKEN to access';
        } else if (resp.status === 404) {
          analysis.error = 'Repository not found or private';
          analysis.requiresToken = true;
          analysis.tokenType = 'github';
        }
      } catch (e) {
        logger.error(`[_analyzeGitHubUrl] API fetch error: ${e.message}`);
        analysis.error = e.message;
      }
    }

    return analysis;
  }

  async _analyzeGradioUrl(url, hfToken, analysis) {
    analysis.sourceType = 'gradio';
    analysis.sdkType = 'gradio';

    const headers = {};
    if (hfToken) {
      headers['Authorization'] = `Bearer ${hfToken}`;
    }

    try {
      // Try to fetch Gradio API info
      const infoUrl = new URL('/info', url).toString();
      const resp = await fetch(infoUrl, { headers });

      if (resp.ok) {
        const data = await resp.json();
        analysis.rawMetadata.gradioInfo = data;

        if (data.api) {
          analysis.gradioEndpoints = Object.entries(data.api).map(([name, info]) => ({
            name,
            inputs: info.parameters?.map(p => p.label || p.parameter_name) || [],
            outputs: info.returns?.map(r => r.label || r.type) || []
          }));
        }

        // Detect input/output types
        analysis.gradioEndpoints.forEach(ep => {
          analysis.detectedInputs.push(...ep.inputs);
          analysis.detectedOutputs.push(...ep.outputs);
        });

        analysis.recommendedApproach = 'api';
        analysis.recommendationReason = 'Gradio app detected - can use @gradio/client JavaScript API';
      } else {
        analysis.recommendedApproach = 'api';
        analysis.recommendationReason = 'Appears to be a Gradio app - try @gradio/client API';
      }
    } catch (e) {
      analysis.recommendedApproach = 'api';
      analysis.recommendationReason = 'Could not fetch API info, but appears to be Gradio - try @gradio/client';
    }

    return analysis;
  }

  async _analyzeUnknownUrl(url, analysis) {
    // Try to detect if it's a Gradio app by checking for /info endpoint
    try {
      const infoUrl = new URL('/info', url).toString();
      const resp = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) });

      if (resp.ok) {
        const data = await resp.json();
        if (data.api || data.version) {
          // Looks like Gradio
          analysis.sourceType = 'gradio';
          analysis.sdkType = 'gradio';
          analysis.rawMetadata.gradioInfo = data;
          analysis.recommendedApproach = 'api';
          analysis.recommendationReason = 'Gradio API detected - can use @gradio/client';
          return analysis;
        }
      }
    } catch (e) {
      // Not a Gradio app or timeout
    }

    analysis.sourceType = 'unknown';
    analysis.recommendedApproach = 'recreate';
    analysis.recommendationReason = 'Unknown source type - consider manually inspecting and recreating functionality';
    return analysis;
  }

  /**
   * Check requirements/dependencies from a local path or URL.
   * Helps understand what dependencies a project needs.
   */
  async artifactCheckRequirements(projectPath, params) {
    const { path: targetPath, url } = params;

    const result = {
      hasPythonDeps: false,
      hasNodeDeps: false,
      hasDockerfile: false,
      pythonDeps: [],
      nodeDeps: [],
      dockerInfo: null,
      estimatedDependencies: []
    };

    if (targetPath) {
      // Check local path
      const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(projectPath, targetPath);

      try {
        // Check for requirements.txt
        const reqPath = path.join(fullPath, 'requirements.txt');
        if (fs.existsSync(reqPath)) {
          result.hasPythonDeps = true;
          const content = await fsp.readFile(reqPath, 'utf8');
          result.pythonDeps = content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => line.split('==')[0].split('>=')[0].split('<=')[0].trim());
          result.estimatedDependencies.push('python', 'pip');
        }

        // Check for package.json
        const pkgPath = path.join(fullPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          result.hasNodeDeps = true;
          const content = await fsp.readFile(pkgPath, 'utf8');
          const pkg = JSON.parse(content);
          result.nodeDeps = Object.keys(pkg.dependencies || {});
          result.estimatedDependencies.push('node', 'npm');
        }

        // Check for Dockerfile
        const dockerPath = path.join(fullPath, 'Dockerfile');
        if (fs.existsSync(dockerPath)) {
          result.hasDockerfile = true;
          const content = await fsp.readFile(dockerPath, 'utf8');
          // Extract base image
          const fromMatch = content.match(/^FROM\s+([^\s]+)/im);
          result.dockerInfo = {
            baseImage: fromMatch ? fromMatch[1] : null,
            contentPreview: content.substring(0, 500)
          };
          result.estimatedDependencies.push('docker');
        }
      } catch (e) {
        result.error = e.message;
      }
    }

    return result;
  }
}

module.exports = BuiltInService;
