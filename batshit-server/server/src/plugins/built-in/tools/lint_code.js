// server/src/plugins/built-in/tools/lint_code.js

const { ESLint } = require('eslint');
const eslintJs = require('@eslint/js');
const globals = require('globals');
const ruffWasm = require('@astral-sh/ruff-wasm-nodejs');
const tsPluginModule = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const { HTMLHint } = require('htmlhint');
const toml = require('toml');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../../../utils/logger');

const tsPlugin = tsPluginModule.default ?? tsPluginModule;
const BASE_ESLINT_GLOBALS = {
  ...globals.browser,
  ...globals.node,
  ...globals.es2021
};
const BASE_ESLINT_FORMAT_RULES = {
  semi: ['error', 'always'],
  quotes: ['error', 'single'],
  'space-infix-ops': 'error',
  'space-before-blocks': 'error',
  'comma-spacing': ['error', { before: false, after: true }],
  'key-spacing': ['error', { beforeColon: false, afterColon: true }],
  'object-curly-spacing': ['error', 'always'],
  'array-bracket-spacing': ['error', 'never'],
  'no-trailing-spaces': 'error',
  'eol-last': 'error'
};
const LEGACY_ESLINT_CONFIG_FILENAMES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml'
];

// Import jsonc-parser for parsing JSONC files
let jsoncParser;
try {
  jsoncParser = require('jsonc-parser');
} catch (error) {
  // Fallback to regular JSON.parse if jsonc-parser is not available
  logger.warn('jsonc-parser not available, falling back to JSON.parse for .jsonc files');
  jsoncParser = null;
}

let stylelintModulePromise = null;
let markdownlintSyncModulePromise = null;
let jsoncPluginModulePromise = null;

async function getStylelint() {
  if (!stylelintModulePromise) {
    stylelintModulePromise = import('stylelint').then((mod) => mod.default ?? mod);
  }

  return stylelintModulePromise;
}

async function getMarkdownlintSync() {
  if (!markdownlintSyncModulePromise) {
    markdownlintSyncModulePromise = import('markdownlint/sync').then((mod) => {
      const root = mod.default ?? mod;
      return {
        ...root,
        sync: typeof root.sync === 'function' ? root.sync.bind(root) : root.lint.bind(root)
      };
    });
  }

  return markdownlintSyncModulePromise;
}

async function getJsoncPlugin() {
  if (!jsoncPluginModulePromise) {
    jsoncPluginModulePromise = import('eslint-plugin-jsonc').then((mod) => mod.default ?? mod);
  }

  return jsoncPluginModulePromise;
}

function isWithinDirectory(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * ESLint integration for the unified lint_code tool
 * Supports JavaScript, TypeScript, JSON, and Markdown code blocks
 */
class ESLintTool {
  static supportsFixing = true;

  constructor() {
    this.name = 'eslint';
    this.supportedLanguages = [
      'javascript',
      'typescript', 
      'json',
      'javascript-in-markdown',
      'typescript-in-markdown'
    ];
  }

  /**
   * Lint code using ESLint
   * @param {string} codeContent - The code to lint
   * @param {string} languageHint - Language hint (e.g., 'javascript', 'typescript', 'json')
   * @param {string} filePath - Optional file path for context
   * @param {string} projectPath - Optional absolute path to the project root
   * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
   * @returns {Object} Standardized lint result
   */
  async lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
    try {
      // Validate inputs
      if (!codeContent || typeof codeContent !== 'string') {
        return this._createErrorResult('Invalid code content provided', languageHint, filePath);
      }

      if (!this.supportedLanguages.includes(languageHint)) {
        return this._createErrorResult(`Unsupported language hint: ${languageHint}`, languageHint, filePath);
      }

      const effectiveLanguageHint = languageHint.endsWith('-in-markdown')
        ? languageHint.replace('-in-markdown', '')
        : languageHint;
      const lintTargetFilePath = this._resolveLintTargetFilePath(
        effectiveLanguageHint,
        filePath,
        projectPath
      );

      if (effectiveLanguageHint === 'json') {
        return await this._lintJsonWithFlatConfig(
          codeContent,
          languageHint,
          filePath,
          lintTargetFilePath,
          applyFixes
        );
      }

      const eslint = await this._createESLintInstance(
        effectiveLanguageHint,
        lintTargetFilePath,
        projectPath,
        useProjectConfig,
        false
      );

      // Handle fixing logic
      if (applyFixes && ESLintTool.supportsFixing) {
        // Get original diagnostics first
        const originalResults = await eslint.lintText(codeContent, {
          filePath: lintTargetFilePath
        });

        const fixingEslint = await this._createESLintInstance(
          effectiveLanguageHint,
          lintTargetFilePath,
          projectPath,
          useProjectConfig,
          true
        );
        
        // Apply fixes
        const fixedResults = await fixingEslint.lintText(codeContent, {
          filePath: lintTargetFilePath
        });

        // Process results with fixing information
        return this._processESLintResultsWithFixes(originalResults, fixedResults, languageHint, filePath, codeContent);
      } else {
        // Standard linting without fixes
        const results = await eslint.lintText(codeContent, {
          filePath: lintTargetFilePath
        });

        // Process and standardize the results
        return this._processESLintResults(results, languageHint, filePath, codeContent, false);
      }

    } catch (error) {
      logger.error(`ESLint error: ${error.message}`);
      return this._createErrorResult(`ESLint failed: ${error.message}`, languageHint, filePath);
    }
  }

  async _createESLintInstance(languageHint, lintTargetFilePath, projectPath, useProjectConfig, applyFixes) {
    const eslintOptions = await this._createESLintOptions(
      languageHint,
      lintTargetFilePath,
      projectPath,
      useProjectConfig,
      applyFixes
    );

    return new ESLint(eslintOptions);
  }

  async _createESLintOptions(languageHint, lintTargetFilePath, projectPath, useProjectConfig, applyFixes) {
    if (useProjectConfig && projectPath) {
      const projectConfigInfo = await this._inspectProjectEslintConfig(projectPath, lintTargetFilePath);

      if (projectConfigInfo.mode === 'legacy') {
        throw new Error(
          `Project ESLint config must migrate to eslint.config.* before Batshit can lint it under ESLint 10 (found ${projectConfigInfo.configFile}). Set useProjectConfig=false to lint with Batshit embedded defaults instead.`
        );
      }

      if (projectConfigInfo.mode === 'flat') {
        return {
          cwd: projectPath,
          fix: applyFixes
        };
      }
    }

    return {
      ...(projectPath ? { cwd: projectPath } : {}),
      overrideConfigFile: true,
      overrideConfig: this._createEmbeddedFlatConfig(languageHint),
      fix: applyFixes
    };
  }

  _createEmbeddedFlatConfig(languageHint) {
    const sharedConfig = {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: BASE_ESLINT_GLOBALS
      }
    };
    const formattingConfig = {
      rules: BASE_ESLINT_FORMAT_RULES
    };

    switch (languageHint) {
      case 'javascript':
        return [sharedConfig, eslintJs.configs.recommended, formattingConfig];

      case 'typescript':
        return [
          {
            ...sharedConfig,
            languageOptions: {
              ...sharedConfig.languageOptions,
              parser: tsParser
            }
          },
          ...tsPlugin.configs['flat/recommended'],
          formattingConfig
        ];

      default:
        return [sharedConfig, eslintJs.configs.recommended, formattingConfig];
    }
  }

  /**
   * Get appropriate file extension for language hint
   */
  _getFileExtension(languageHint, filePath) {
    if (filePath) {
      const ext = filePath.split('.').pop();
      if (ext) return `.${ext}`;
    }

    const extensionMap = {
      'javascript': '.js',
      'typescript': '.ts',
      'json': '.json',
      'javascript-in-markdown': '.md',
      'typescript-in-markdown': '.md'
    };

    return extensionMap[languageHint] || '.js';
  }

  _resolveLintTargetFilePath(languageHint, filePath, projectPath) {
    const fileExtension = this._getFileExtension(languageHint, filePath);

    if (filePath) {
      return filePath;
    }

    if (projectPath) {
      return `__batshit_lint__${fileExtension}`;
    }

    return `temp${fileExtension}`;
  }

  async _inspectProjectEslintConfig(projectPath, lintTargetFilePath) {
    const projectRoot = path.resolve(projectPath);
    const discoveryEslint = new ESLint({ cwd: projectRoot });
    const discoveredConfigFile = await discoveryEslint.findConfigFile(lintTargetFilePath);
    const resolvedConfigFile = discoveredConfigFile ? path.resolve(discoveredConfigFile) : null;

    if (resolvedConfigFile) {
      return {
        mode: 'flat',
        configFile: resolvedConfigFile
      };
    }

    const legacyConfigFile = this._findLegacyEslintConfig(projectRoot, lintTargetFilePath);
    if (legacyConfigFile) {
      return {
        mode: 'legacy',
        configFile: legacyConfigFile
      };
    }

    return {
      mode: 'none',
      configFile: null
    };
  }

  _findLegacyEslintConfig(projectRoot, lintTargetFilePath) {
    const absoluteProjectRoot = path.resolve(projectRoot);
    const resolvedLintPath = path.isAbsolute(lintTargetFilePath)
      ? lintTargetFilePath
      : path.join(absoluteProjectRoot, lintTargetFilePath);
    let currentDir = path.dirname(resolvedLintPath);

    while (isWithinDirectory(absoluteProjectRoot, currentDir)) {
      for (const configFileName of LEGACY_ESLINT_CONFIG_FILENAMES) {
        const candidatePath = path.join(currentDir, configFileName);
        if (fs.existsSync(candidatePath)) {
          return candidatePath;
        }
      }

      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          if (packageJson.eslintConfig) {
            return `${packageJsonPath}#eslintConfig`;
          }
        } catch (error) {
          logger.warn(`Failed to inspect ${packageJsonPath} for eslintConfig: ${error.message}`);
        }
      }

      if (currentDir === absoluteProjectRoot) {
        break;
      }

      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  async _lintJsonWithFlatConfig(codeContent, languageHint, filePath, lintTargetFilePath, applyFixes = false) {
    try {
      const jsoncPlugin = await getJsoncPlugin();
      const baseConfig =
        jsoncPlugin.configs?.['flat/recommended-with-jsonc'] ??
        jsoncPlugin.configs?.['recommended-with-jsonc'] ??
        [];

      const eslint = new ESLint({
        overrideConfigFile: true,
        overrideConfig: baseConfig,
        fix: applyFixes
      });

      const results = await eslint.lintText(codeContent, {
        filePath: lintTargetFilePath
      });

      if (applyFixes && ESLintTool.supportsFixing) {
        return this._processESLintResultsWithFixes(results, results, languageHint, filePath, codeContent);
      }

      return this._processESLintResults(results, languageHint, filePath, codeContent, false);
    } catch (error) {
      logger.error(`JSON ESLint error: ${error.message}`);
      return this._createErrorResult(`JSON linting failed: ${error.message}`, languageHint, filePath);
    }
  }

  /**
   * Process ESLint results into standardized format
   */
  _processESLintResults(results, languageHint, filePath, originalCodeContent, isFixed = false) {
    const diagnostics = [];
    let errorCount = 0;
    let warningCount = 0;

    for (const result of results) {
      for (const message of result.messages) {
        const diagnostic = {
          severity: message.severity === 2 ? 'error' : 'warning',
          message: message.message,
          ruleId: message.ruleId || 'unknown',
          line: message.line,
          column: message.column
        };

        // Add end position if available
        if (message.endLine) diagnostic.endLine = message.endLine;
        if (message.endColumn) diagnostic.endColumn = message.endColumn;

        diagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          errorCount++;
        } else {
          warningCount++;
        }
      }
    }

    const resultObj = {
      linterUsed: 'eslint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics,
      errorCount,
      warningCount,
      isSuccess: true
    };

    // Add fixing-related fields
    resultObj.fixedCodeContent = originalCodeContent;
    resultObj.fixesAppliedCount = 0;
    resultObj.originalDiagnostics = diagnostics;
    resultObj.remainingDiagnostics = diagnostics;

    return resultObj;
  }

  /**
   * Process ESLint results with fixing information
   */
  _processESLintResultsWithFixes(originalResults, fixedResults, languageHint, filePath, originalCodeContent) {
    const originalDiagnostics = [];
    const remainingDiagnostics = [];
    let originalErrorCount = 0;
    let originalWarningCount = 0;
    let remainingErrorCount = 0;
    let remainingWarningCount = 0;

    // Process original diagnostics
    for (const result of originalResults) {
      for (const message of result.messages) {
        const diagnostic = {
          severity: message.severity === 2 ? 'error' : 'warning',
          message: message.message,
          ruleId: message.ruleId || 'unknown',
          line: message.line,
          column: message.column
        };

        if (message.endLine) diagnostic.endLine = message.endLine;
        if (message.endColumn) diagnostic.endColumn = message.endColumn;

        originalDiagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          originalErrorCount++;
        } else {
          originalWarningCount++;
        }
      }
    }

    // Process remaining diagnostics and extract fixed code
    let fixedCodeContent = originalCodeContent;
    for (const result of fixedResults) {
      // Extract fixed code if available
      if (result.output !== undefined) {
        fixedCodeContent = result.output;
      }

      for (const message of result.messages) {
        const diagnostic = {
          severity: message.severity === 2 ? 'error' : 'warning',
          message: message.message,
          ruleId: message.ruleId || 'unknown',
          line: message.line,
          column: message.column
        };

        if (message.endLine) diagnostic.endLine = message.endLine;
        if (message.endColumn) diagnostic.endColumn = message.endColumn;

        remainingDiagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          remainingErrorCount++;
        } else {
          remainingWarningCount++;
        }
      }
    }

    // Calculate fixes applied count
    const fixesAppliedCount = Math.max(0, originalDiagnostics.length - remainingDiagnostics.length);

    return {
      linterUsed: 'eslint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent,
      fixesAppliedCount,
      originalDiagnostics,
      remainingDiagnostics,
      diagnostics: remainingDiagnostics, // For backward compatibility
      errorCount: remainingErrorCount,
      warningCount: remainingWarningCount,
      isSuccess: true
    };
  }

  /**
   * Create standardized error result
   */
  _createErrorResult(errorMessage, languageHint, filePath) {
    return {
      linterUsed: 'eslint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: errorMessage
    };
  }
}

/**
 * Ruff integration for the unified lint_code tool
 * Supports Python code linting
 */
class RuffTool {
  static supportsFixing = true;

  constructor() {
    this.name = 'ruff';
    this.supportedLanguages = ['python'];
    this.wasmInitialized = false;
    this.initPromise = null;
  }

  async initializeWasm() {
    if (this.wasmInitialized) {
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._performWasmInit();
    return this.initPromise;
  }

  async _performWasmInit() {
    try {
      logger.debug('Initializing Ruff WASM module...');
      // Test basic WASM functionality
      const testMethods = Object.keys(ruffWasm).filter(k => !k.startsWith('__'));
      logger.debug(`Available Ruff methods: ${testMethods.join(', ')}`);
      
      this.wasmInitialized = true;
      return true;
    } catch (error) {
      logger.warn(`Ruff WASM initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Lint Python code using Ruff
   * @param {string} codeContent - The code to lint
   * @param {string} languageHint - Language hint (should be 'python')
   * @param {string} filePath - Optional file path for context
   * @param {string} projectPath - Optional absolute path to the project root
   * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
   * @returns {Object} Standardized lint result
   */
  async lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
    try {
      // Validate inputs
      if (!codeContent || typeof codeContent !== 'string') {
        return this._createErrorResult('Invalid code content provided', languageHint, filePath);
      }

      if (!this.supportedLanguages.includes(languageHint)) {
        return this._createErrorResult(`Unsupported language hint: ${languageHint}`, languageHint, filePath);
      }

      await this.initializeWasm();
      
      // Determine Ruff configuration to use
      let ruffSettings = null;
      let configSource = 'embedded-defaults';
      
      if (useProjectConfig && projectPath && typeof projectPath === 'string' && projectPath.trim() !== '') {
        try {
          const projectConfig = this._loadProjectConfig(projectPath);
          if (projectConfig) {
            ruffSettings = projectConfig;
            configSource = 'project-config';
            logger.debug(`Ruff using project configuration from ${projectPath}`);
          } else {
            logger.debug(`No Ruff project configuration found in ${projectPath}, using embedded defaults`);
          }
        } catch (configError) {
          logger.warn(`Failed to load Ruff project configuration: ${configError.message}, falling back to embedded defaults`);
        }
      }

      // Execute Ruff with multiple fallback strategies
      const result = await this._executeRuffWithFallbacks(codeContent, ruffSettings, applyFixes);
      
      return {
        linterUsed: 'ruff',
        filePathProvided: filePath,
        languageHintProvided: languageHint,
        diagnostics: result.diagnostics || [],
        errorCount: result.errorCount || 0,
        warningCount: result.warningCount || 0,
        isSuccess: true,
        fixedCodeContent: result.fixedCodeContent,
        fixesAppliedCount: result.fixesAppliedCount || 0,
        remainingDiagnostics: result.remainingDiagnostics
      };
      
    } catch (ruffError) {
      // Handle known WASM issues gracefully
      const isSetLoggerError = ruffError.message && ruffError.message.includes('SetLoggerError');
      const isReflectError = ruffError.message && ruffError.message.includes('Reflect.get');
      
      if (isSetLoggerError) {
        logger.warn(`Ruff WASM logger initialization issue (known): ${ruffError.message}`);
      } else if (isReflectError) {
        logger.warn(`Ruff WASM binding issue (known): ${ruffError.message}`);
      } else {
        logger.warn(`Ruff WASM execution failed: ${ruffError.message}`);
      }
      
      // Return graceful fallback for any WASM issues
      return {
        linterUsed: 'ruff',
        filePathProvided: filePath,
        languageHintProvided: languageHint,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        isSuccess: true,
        ruffNote: `Ruff integration is available but WASM execution encountered issues: ${ruffError.message}. This is a known limitation that will be resolved in future updates.`,
        debugInfo: {
          errorType: ruffError.constructor.name,
          isSetLoggerError,
          isReflectError,
          wasmInitialized: this.wasmInitialized
        }
      };
    }
  }

  async _executeRuffWithFallbacks(code, config, applyFixes) {
    const strategies = [
      () => this._tryWorkspaceAPI(code, config, applyFixes),
      () => this._tryDirectWasmAPI(code, config, applyFixes),
      () => this._tryRunAPI(code, config, applyFixes)
    ];

    let lastError = null;
    
    for (const strategy of strategies) {
      try {
        const strategyName = strategy.name || 'unknown';
        logger.debug(`Trying Ruff execution strategy: ${strategyName}`);
        const result = await strategy();
        logger.debug(`✓ Strategy ${strategyName} succeeded`);
        return result;
      } catch (error) {
        const strategyName = strategy.name || 'unknown';
        logger.debug(`✗ Strategy ${strategyName} failed: ${error.message}`);
        lastError = error;
        continue;
      }
    }
    
    throw lastError || new Error('All Ruff execution strategies failed');
  }

  async _tryWorkspaceAPI(code, config, applyFixes) {
    logger.debug('Attempting Workspace API...');
    
    try {
      // Create workspace with configuration
      const workspaceConfig = this._convertConfigToWorkspaceFormat(config);
      logger.debug('Workspace config:', JSON.stringify(workspaceConfig, null, 2));
      
      // Try to create workspace - this might fail due to WASM issues
      let workspace;
      try {
        workspace = new ruffWasm.Workspace(workspaceConfig);
      } catch (workspaceError) {
        logger.debug('Workspace creation failed:', workspaceError.message);
        throw new Error(`Workspace creation failed: ${workspaceError.message}`);
      }
      
      // Get diagnostics
      let diagnostics;
      try {
        diagnostics = workspace.check(code);
        logger.debug(`Workspace check found ${diagnostics.length} diagnostics`);
      } catch (checkError) {
        logger.debug('Workspace check failed:', checkError.message);
        throw new Error(`Workspace check failed: ${checkError.message}`);
      }
      
      const processedDiagnostics = this._processRuffResults(diagnostics);
      
      let result = {
        diagnostics: processedDiagnostics.diagnostics,
        errorCount: processedDiagnostics.errorCount,
        warningCount: processedDiagnostics.warningCount,
        fixedCodeContent: code,
        fixesAppliedCount: 0,
        remainingDiagnostics: processedDiagnostics.diagnostics
      };

      // Apply fixes if requested
      if (applyFixes && RuffTool.supportsFixing && diagnostics.length > 0) {
        try {
          logger.debug('Attempting to format code...');
          const fixedCode = workspace.format(code);
          
          if (fixedCode && fixedCode !== code) {
            logger.debug('Code was formatted, re-checking diagnostics...');
            // Re-check for remaining diagnostics after fixing
            const remainingDiagnostics = workspace.check(fixedCode);
            const processedRemaining = this._processRuffResults(remainingDiagnostics);
            
            result.fixedCodeContent = fixedCode;
            result.fixesAppliedCount = Math.max(0, diagnostics.length - remainingDiagnostics.length);
            result.remainingDiagnostics = processedRemaining.diagnostics;
            
            logger.debug(`Applied ${result.fixesAppliedCount} fixes, ${remainingDiagnostics.length} issues remaining`);
          } else {
            logger.debug('No formatting changes applied');
          }
        } catch (fixError) {
          logger.debug('Workspace API fixing failed, returning diagnostics only:', fixError.message);
          // Continue with diagnostics-only result
        }
      }

      return result;
      
    } catch (error) {
      logger.debug('Workspace API failed completely:', error.message);
      throw error;
    }
  }

  async _tryRunAPI(code, config, applyFixes) {
    logger.debug('Attempting Run API...');
    
    // The Run API has known issues with logger initialization
    // Let's try a simpler approach that avoids the problematic ruff.run() call
    throw new Error('Run API disabled due to WASM logger initialization issues');
  }

  /**
   * Try a direct WASM approach without using the problematic APIs
   */
  async _tryDirectWasmAPI(code, config, applyFixes) {
    logger.debug('Attempting Direct WASM API...');
    
    try {
      // Try to use Ruff's check function directly if available
      if (typeof ruffWasm.check === 'function') {
        logger.debug('Using direct check function...');
        const diagnostics = ruffWasm.check(code, config || {});
        
        const processedDiagnostics = this._processRuffResults(diagnostics || []);
        
        let result = {
          diagnostics: processedDiagnostics.diagnostics,
          errorCount: processedDiagnostics.errorCount,
          warningCount: processedDiagnostics.warningCount,
          fixedCodeContent: code,
          fixesAppliedCount: 0,
          remainingDiagnostics: processedDiagnostics.diagnostics
        };

        // Try to apply fixes if requested
        if (applyFixes && RuffTool.supportsFixing && typeof ruffWasm.format === 'function') {
          try {
            const fixedCode = ruffWasm.format(code, config || {});
            if (fixedCode && fixedCode !== code) {
              // Re-check diagnostics
              const remainingDiagnostics = ruffWasm.check(fixedCode, config || {});
              const processedRemaining = this._processRuffResults(remainingDiagnostics || []);
              
              result.fixedCodeContent = fixedCode;
              result.fixesAppliedCount = Math.max(0, (diagnostics || []).length - (remainingDiagnostics || []).length);
              result.remainingDiagnostics = processedRemaining.diagnostics;
            }
          } catch (fixError) {
            logger.debug('Direct WASM fixing failed:', fixError.message);
          }
        }

        return result;
      } else {
        throw new Error('Direct check function not available');
      }
    } catch (error) {
      logger.debug('Direct WASM API failed:', error.message);
      throw error;
    }
  }

  _convertConfigToWorkspaceFormat(config) {
    // Convert project config to Workspace API format
    // If no config provided, use enhanced defaults for better autofixing
    if (!config) {
      return this._getEnhancedDefaultConfig();
    }
    
    const workspaceConfig = {};
    
    if (config.select) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.select = config.select;
    }
    
    if (config.ignore) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.ignore = config.ignore;
    }
    
    if (config.extend_select) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.extend_select = config.extend_select;
    }
    
    if (config.extend_ignore) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.extend_ignore = config.extend_ignore;
    }
    
    if (config.fixable) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.fixable = config.fixable;
    }
    
    if (config.unfixable) {
      workspaceConfig.lint = workspaceConfig.lint || {};
      workspaceConfig.lint.unfixable = config.unfixable;
    }
    
    if (config['line-length'] || config.line_length) {
      workspaceConfig['line-length'] = config['line-length'] || config.line_length;
    }
    
    if (config.target_version) {
      workspaceConfig.target_version = config.target_version;
    }
    
    return workspaceConfig;
  }

  /**
   * Get enhanced default configuration optimized for autofixing
   * @returns {Object} Enhanced default Ruff configuration
   */
  _getEnhancedDefaultConfig() {
    return {
      lint: {
        // Select common, safe, and auto-fixable rules
        select: [
          // Import sorting and organization
          "I",     // isort - Import sorting
          
          // Code formatting that Ruff can autofix
          "E1",    // Indentation errors
          "E2",    // Whitespace errors
          "E3",    // Blank line errors
          "W1",    // Indentation warnings
          "W2",    // Whitespace warnings
          "W3",    // Blank line warnings
          
          // Simple style fixes
          "E701",  // Multiple statements on one line (colon)
          "E702",  // Multiple statements on one line (semicolon)
          "E703",  // Statement ends with a semicolon
          "E711",  // Comparison to None should be 'is' or 'is not'
          "E712",  // Comparison to True should be 'is' or 'is not'
          "E713",  // Test for membership should be 'not in'
          "E714",  // Test for object identity should be 'is not'
          
          // Pyflakes errors that can be auto-fixed
          "F401",  // Unused imports
          
          // pyupgrade rules for modernizing Python code
          "UP",    // pyupgrade - Modernize Python code
        ],
        
        // Ignore rules that might be too aggressive or not auto-fixable
        ignore: [
          "F403",  // Star imports (often intentional)
          "F405",  // Name may be undefined due to star import
          "E501",  // Line too long (let formatter handle this)
          "E731",  // Lambda assignment (often intentional)
          "F821",  // Undefined name (might be dynamic)
          "F822",  // Undefined name in __all__
          "F823",  // Local variable referenced before assignment
          "F841",  // Unused variables (might be intentional)
          "E9",    // Runtime errors (need manual review)
        ],
        
        // Specify which rules are fixable (allow most common ones)
        fixable: [
          "I",     // Import sorting
          "E1",    // Indentation
          "E2",    // Whitespace
          "E3",    // Blank lines
          "W1",    // Indentation warnings
          "W2",    // Whitespace warnings
          "W3",    // Blank line warnings
          "E701",  // Multiple statements
          "E702",  // Multiple statements
          "E703",  // Semicolon
          "E711",  // None comparison
          "E712",  // True/False comparison
          "E713",  // not in
          "E714",  // is not
          "F401",  // Unused imports
          "UP",    // pyupgrade
        ],
        
        // Don't fix these automatically (might change behavior)
        unfixable: [
          "F841",  // Unused variables (might be intentional)
          "E9",    // Runtime errors (need manual review)
        ]
      },
      
      // Set reasonable line length
      "line-length": 88,
      
      // Show fixes in output
      "show-fixes": true,
    };
  }

  /**
   * Process Ruff results into standardized format
   */
  _processRuffResults(ruffResults, languageHint, filePath) {
    const diagnostics = [];
    let errorCount = 0;
    let warningCount = 0;

    for (const diagnostic of ruffResults) {
      // Map Ruff diagnostic to standardized format
      const standardDiagnostic = {
        severity: this._mapRuffSeverity(diagnostic),
        message: diagnostic.message || 'Unknown error',
        ruleId: diagnostic.code || 'unknown',
        line: diagnostic.location?.row || 1,
        column: diagnostic.location?.column || 1
      };

      // Add end position if available
      if (diagnostic.end_location) {
        standardDiagnostic.endLine = diagnostic.end_location.row;
        standardDiagnostic.endColumn = diagnostic.end_location.column;
      }

      diagnostics.push(standardDiagnostic);

      if (standardDiagnostic.severity === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }

    return {
      linterUsed: 'ruff',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics,
      errorCount,
      warningCount,
      isSuccess: true
    };
  }

  /**
   * Map Ruff severity to standardized severity
   * Ruff typically reports violations as errors, but we can categorize them
   */
  _mapRuffSeverity(diagnostic) {
    // Ruff doesn't have explicit severity levels like ESLint
    // For Phase 1, we'll treat most violations as warnings unless they're syntax errors
    // This can be refined in future phases based on rule categories
    
    if (diagnostic.code) {
      // Syntax errors (E999) and some critical errors should be 'error'
      if (diagnostic.code.startsWith('E999') || diagnostic.code.startsWith('F')) {
        return 'error';
      }
    }
    
    // Default to warning for most style and convention violations
    return 'warning';
  }

  /**
   * Load project-specific Ruff configuration from ruff.toml or pyproject.toml
   * @param {string} projectPath - Absolute path to the project root
   * @returns {Object|null} Parsed Ruff configuration or null if not found
   */
  _loadProjectConfig(projectPath) {
    try {
      // First, try to find ruff.toml
      const ruffTomlPath = path.join(projectPath, 'ruff.toml');
      if (fs.existsSync(ruffTomlPath)) {
        logger.debug(`Found ruff.toml at ${ruffTomlPath}`);
        const tomlContent = fs.readFileSync(ruffTomlPath, 'utf8');
        const parsedConfig = toml.parse(tomlContent);
        return this._convertTomlToRuffSettings(parsedConfig);
      }

      // If ruff.toml not found, try pyproject.toml
      const pyprojectTomlPath = path.join(projectPath, 'pyproject.toml');
      if (fs.existsSync(pyprojectTomlPath)) {
        logger.debug(`Found pyproject.toml at ${pyprojectTomlPath}`);
        const tomlContent = fs.readFileSync(pyprojectTomlPath, 'utf8');
        const parsedConfig = toml.parse(tomlContent);
        
        // Extract [tool.ruff] section
        if (parsedConfig.tool && parsedConfig.tool.ruff) {
          return this._convertTomlToRuffSettings(parsedConfig.tool.ruff);
        } else {
          logger.debug('No [tool.ruff] section found in pyproject.toml');
          return null;
        }
      }

      // No configuration files found
      logger.debug(`No Ruff configuration files found in ${projectPath}`);
      return null;

    } catch (error) {
      logger.warn(`Error loading Ruff project configuration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert TOML configuration to Ruff WASM Settings object
   * @param {Object} tomlConfig - Parsed TOML configuration
   * @returns {Object} Ruff WASM compatible settings object
   */
  _convertTomlToRuffSettings(tomlConfig) {
    try {
      // Create a settings object compatible with Ruff WASM API
      const settings = {};

      // Map common Ruff configuration options
      if (tomlConfig.select) {
        settings.select = Array.isArray(tomlConfig.select) ? tomlConfig.select : [tomlConfig.select];
      }

      if (tomlConfig.ignore) {
        settings.ignore = Array.isArray(tomlConfig.ignore) ? tomlConfig.ignore : [tomlConfig.ignore];
      }

      if (tomlConfig.extend_select) {
        settings.extend_select = Array.isArray(tomlConfig.extend_select) ? tomlConfig.extend_select : [tomlConfig.extend_select];
      }

      if (tomlConfig.extend_ignore) {
        settings.extend_ignore = Array.isArray(tomlConfig.extend_ignore) ? tomlConfig.extend_ignore : [tomlConfig.extend_ignore];
      }

      if (tomlConfig.fixable) {
        settings.fixable = Array.isArray(tomlConfig.fixable) ? tomlConfig.fixable : [tomlConfig.fixable];
      }

      if (tomlConfig.unfixable) {
        settings.unfixable = Array.isArray(tomlConfig.unfixable) ? tomlConfig.unfixable : [tomlConfig.unfixable];
      }

      if (tomlConfig.line_length !== undefined) {
        settings.line_length = tomlConfig.line_length;
      }

      if (tomlConfig.target_version) {
        settings.target_version = tomlConfig.target_version;
      }

      if (tomlConfig.exclude) {
        settings.exclude = Array.isArray(tomlConfig.exclude) ? tomlConfig.exclude : [tomlConfig.exclude];
      }

      if (tomlConfig.extend_exclude) {
        settings.extend_exclude = Array.isArray(tomlConfig.extend_exclude) ? tomlConfig.extend_exclude : [tomlConfig.extend_exclude];
      }

      // Handle per-file-ignores
      if (tomlConfig.per_file_ignores || tomlConfig['per-file-ignores']) {
        settings.per_file_ignores = tomlConfig.per_file_ignores || tomlConfig['per-file-ignores'];
      }

      // Handle rule-specific configurations
      if (tomlConfig.flake8_quotes) {
        settings.flake8_quotes = tomlConfig.flake8_quotes;
      }

      if (tomlConfig.mccabe) {
        settings.mccabe = tomlConfig.mccabe;
      }

      if (tomlConfig.pep8_naming) {
        settings.pep8_naming = tomlConfig.pep8_naming;
      }

      // Handle other common options
      if (tomlConfig.show_fixes !== undefined) {
        settings.show_fixes = tomlConfig.show_fixes;
      }

      if (tomlConfig.show_source !== undefined) {
        settings.show_source = tomlConfig.show_source;
      }

      logger.debug('Converted TOML config to Ruff settings:', JSON.stringify(settings, null, 2));
      return settings;

    } catch (error) {
      logger.warn(`Error converting TOML config to Ruff settings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create standardized error result
   */
  _createErrorResult(errorMessage, languageHint, filePath) {
    return {
      linterUsed: 'ruff',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: errorMessage
    };
  }
}

/**
 * Stylelint integration for the unified lint_code tool
 * Supports CSS, SCSS, and Less code linting
 */
class StylelintTool {
  static supportsFixing = true;

  constructor() {
    this.name = 'stylelint';
    this.supportedLanguages = ['css', 'scss', 'less'];
  }

  /**
   * Lint CSS/SCSS/Less code using Stylelint
   * @param {string} codeContent - The code to lint
   * @param {string} languageHint - Language hint ('css', 'scss', 'less')
   * @param {string} filePath - Optional file path for context
   * @param {string} projectPath - Optional absolute path to the project root
   * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
   * @param {boolean} applyFixes - Whether to apply automatic fixes (default: false)
   * @returns {Object} Standardized lint result with fixing support
   */
  async lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
    try {
      const stylelint = await getStylelint();

      // Validate inputs
      if (!codeContent || typeof codeContent !== 'string') {
        return this._createErrorResult('Invalid code content provided', languageHint, filePath);
      }

      if (!this.supportedLanguages.includes(languageHint)) {
        return this._createErrorResult(`Unsupported language hint: ${languageHint}`, languageHint, filePath);
      }

      // Prepare lint options based on configuration strategy
      let lintOptions;
      
      if (useProjectConfig && projectPath && typeof projectPath === 'string' && projectPath.trim() !== '') {
        // Use project-specific configuration discovery
        lintOptions = {
          code: codeContent,
          cwd: projectPath,
          allowEmptyInput: true
        };
        
        // Add file path if provided for better context
        if (filePath) {
          lintOptions.codeFilename = filePath;
        }
        
        // For project config discovery, we still need to hint the syntax if not explicit in project config
        const syntax = this._getSyntax(languageHint);
        const customSyntax = this._getCustomSyntax(languageHint);
        
        if (syntax) {
          lintOptions.syntax = syntax;
        }
        
        if (customSyntax) {
          lintOptions.customSyntax = customSyntax;
        }
        
        // Do NOT pass 'config' here to let Stylelint find project's own .stylelintrc.*
      } else {
        // Use embedded default configuration
        const stylelintConfig = this._createStylelintConfig(languageHint);
        const syntax = this._getSyntax(languageHint);
        const customSyntax = this._getCustomSyntax(languageHint);
        
        lintOptions = {
          code: codeContent,
          config: stylelintConfig,
          // Set configBasedir to the server directory where stylelint packages are installed
          configBasedir: __dirname + '/../../..',
          // Ensure we use the provided config and don't search for external configs
          allowEmptyInput: true
        };

        // Add file path if provided for better context
        if (filePath) {
          lintOptions.codeFilename = filePath;
        }

        // Add syntax if needed (for SCSS)
        if (syntax) {
          lintOptions.syntax = syntax;
        }

        // Add custom syntax if needed (for Less)
        if (customSyntax) {
          lintOptions.customSyntax = customSyntax;
        }
      }

      // Handle fixing logic
      if (applyFixes && StylelintTool.supportsFixing) {
        // Get original diagnostics first
        const originalResult = await stylelint.lint(lintOptions);

        // Apply fixes
        const fixOptions = { ...lintOptions, fix: true };
        const fixedResult = await stylelint.lint(fixOptions);

        // Process results with fixing information
        return this._processStylelintResultsWithFixes(originalResult, fixedResult, languageHint, filePath, codeContent);
      } else {
        // Standard linting without fixes
        const result = await stylelint.lint(lintOptions);

        // Process and standardize the results
        return this._processStylelintResults(result, languageHint, filePath, codeContent, false);
      }

    } catch (error) {
      logger.error(`Stylelint error: ${error.message}`);
      return this._createErrorResult(`Stylelint failed: ${error.message}`, languageHint, filePath);
    }
  }

  /**
   * Create Stylelint configuration based on language hint
   * Uses embedded default configurations to avoid loading external config files
   */
  _createStylelintConfig(languageHint) {
    let baseConfig = {};

    switch (languageHint) {
      case 'css':
        // Use stylelint-config-standard which includes valid, auto-fixable rules
        baseConfig = {
          extends: ['stylelint-config-standard']
        };
        break;

      case 'scss':
        // Use stylelint-config-standard-scss for SCSS support
        baseConfig = {
          extends: ['stylelint-config-standard-scss']
        };
        break;

      case 'less':
        // Use standard config with Less-specific customizations
        baseConfig = {
          extends: ['stylelint-config-standard'],
          rules: {
            // Allow Less-specific syntax
            'at-rule-no-unknown': null,
            'property-no-unknown': [true, {
              ignoreProperties: ['/^@/'] // Allow Less variables starting with @
            }],
            'function-no-unknown': [true, {
              ignoreFunctions: ['/^-/'] // Allow Less functions starting with -
            }]
          }
        };
        break;

      default:
        // Use standard config as fallback
        baseConfig = {
          extends: ['stylelint-config-standard']
        };
    }

    return baseConfig;
  }

  /**
   * Get syntax for Stylelint based on language hint
   */
  _getSyntax(languageHint) {
    const syntaxMap = {
      'scss': 'scss',
      'less': undefined, // We'll use customSyntax for Less instead
      'css': undefined // CSS doesn't need explicit syntax
    };

    return syntaxMap[languageHint];
  }

  /**
   * Get custom syntax for Stylelint based on language hint
   */
  _getCustomSyntax(languageHint) {
    const customSyntaxMap = {
      'less': 'postcss-less',
      'scss': undefined, // SCSS uses built-in syntax
      'css': undefined // CSS doesn't need custom syntax
    };

    return customSyntaxMap[languageHint];
  }

  /**
   * Process Stylelint results into standardized format
   */
  _processStylelintResults(result, languageHint, filePath, originalCodeContent, isFixed = false) {
    const diagnostics = [];
    let errorCount = 0;
    let warningCount = 0;

    // Stylelint returns results array, we need the first (and usually only) result
    if (result.results && result.results.length > 0) {
      const firstResult = result.results[0];
      
      for (const warning of firstResult.warnings) {
        const diagnostic = {
          severity: warning.severity === 'error' ? 'error' : 'warning',
          message: warning.text,
          ruleId: warning.rule || 'unknown',
          line: warning.line || 1,
          column: warning.column || 1
        };

        // Add end position if available
        if (warning.endLine) diagnostic.endLine = warning.endLine;
        if (warning.endColumn) diagnostic.endColumn = warning.endColumn;

        diagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          errorCount++;
        } else {
          warningCount++;
        }
      }
    }

    const resultObj = {
      linterUsed: 'stylelint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics,
      errorCount,
      warningCount,
      isSuccess: true
    };

    // Add fixing-related fields
    resultObj.fixedCodeContent = originalCodeContent;
    resultObj.fixesAppliedCount = 0;
    resultObj.originalDiagnostics = diagnostics;
    resultObj.remainingDiagnostics = diagnostics;

    return resultObj;
  }

  /**
   * Process Stylelint results with fixing information
   */
  _processStylelintResultsWithFixes(originalResult, fixedResult, languageHint, filePath, originalCodeContent) {
    const originalDiagnostics = [];
    const remainingDiagnostics = [];
    let originalErrorCount = 0;
    let originalWarningCount = 0;
    let remainingErrorCount = 0;
    let remainingWarningCount = 0;

    // Process original diagnostics
    if (originalResult.results && originalResult.results.length > 0) {
      const firstOriginalResult = originalResult.results[0];
      
      for (const warning of firstOriginalResult.warnings) {
        const diagnostic = {
          severity: warning.severity === 'error' ? 'error' : 'warning',
          message: warning.text,
          ruleId: warning.rule || 'unknown',
          line: warning.line || 1,
          column: warning.column || 1
        };

        if (warning.endLine) diagnostic.endLine = warning.endLine;
        if (warning.endColumn) diagnostic.endColumn = warning.endColumn;

        originalDiagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          originalErrorCount++;
        } else {
          originalWarningCount++;
        }
      }
    }

    // Process remaining diagnostics and extract fixed code
    let fixedCodeContent = originalCodeContent;
    
    // In Stylelint 16+, the fixed code is available at the top-level 'code' property
    // (not in results[0].output as in older versions)
    if (fixedResult.code !== undefined) {
      fixedCodeContent = fixedResult.code;
    } else if (fixedResult.output !== undefined) {
      // Fallback to 'output' property (deprecated but may still exist)
      fixedCodeContent = fixedResult.output;
    } else if (fixedResult.results && fixedResult.results.length > 0) {
      // Fallback to PostCSS result method for older versions
      const firstFixedResult = fixedResult.results[0];
      if (firstFixedResult._postcssResult && firstFixedResult._postcssResult.root) {
        try {
          fixedCodeContent = firstFixedResult._postcssResult.root.toString();
        } catch (postcssError) {
          logger.warn('Failed to extract fixed code from PostCSS result:', postcssError.message);
        }
      }
    }
    
    // Process remaining diagnostics from results array
    if (fixedResult.results && fixedResult.results.length > 0) {
      const firstFixedResult = fixedResult.results[0];
      
      for (const warning of firstFixedResult.warnings) {
        const diagnostic = {
          severity: warning.severity === 'error' ? 'error' : 'warning',
          message: warning.text,
          ruleId: warning.rule || 'unknown',
          line: warning.line || 1,
          column: warning.column || 1
        };

        if (warning.endLine) diagnostic.endLine = warning.endLine;
        if (warning.endColumn) diagnostic.endColumn = warning.endColumn;

        remainingDiagnostics.push(diagnostic);

        if (diagnostic.severity === 'error') {
          remainingErrorCount++;
        } else {
          remainingWarningCount++;
        }
      }
    }

    // Calculate fixes applied count
    const fixesAppliedCount = Math.max(0, originalDiagnostics.length - remainingDiagnostics.length);

    return {
      linterUsed: 'stylelint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent,
      fixesAppliedCount,
      originalDiagnostics,
      remainingDiagnostics,
      diagnostics: remainingDiagnostics, // For backward compatibility
      errorCount: remainingErrorCount,
      warningCount: remainingWarningCount,
      isSuccess: true
    };
  }

  /**
   * Create standardized error result
   */
  _createErrorResult(errorMessage, languageHint, filePath) {
    return {
      linterUsed: 'stylelint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: errorMessage
    };
  }
}

/**
 * HTMLHint integration for the unified lint_code tool
 * Supports HTML code linting
 */
class HTMLHintTool {
  static supportsFixing = false;

  constructor() {
    this.name = 'htmlhint';
    this.supportedLanguages = ['html'];
  }

  /**
   * Lint HTML code using HTMLHint
   * @param {string} codeContent - The HTML code to lint
   * @param {string} languageHint - Language hint (should be 'html')
   * @param {string} filePath - Optional file path for context
   * @param {string} projectPath - Optional absolute path to the project root
   * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
   * @param {boolean} applyFixes - Whether to apply automatic fixes (default: false, not supported by HTMLHint)
   * @returns {Object} Standardized lint result
   */
  async lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
    try {
      const markdownlint = await getMarkdownlintSync();

      // Validate inputs
      if (!codeContent || typeof codeContent !== 'string') {
        return this._createErrorResult('Invalid code content provided', languageHint, filePath);
      }

      if (!this.supportedLanguages.includes(languageHint)) {
        return this._createErrorResult(`Unsupported language hint: ${languageHint}`, languageHint, filePath);
      }

      // Determine HTMLHint configuration to use
      let ruleSet = null;
      let configSource = 'embedded-defaults';
      
      if (useProjectConfig && projectPath && typeof projectPath === 'string' && projectPath.trim() !== '') {
        try {
          const projectConfig = this._loadProjectConfig(projectPath);
          if (projectConfig) {
            ruleSet = projectConfig;
            configSource = 'project-config';
            logger.debug(`HTMLHint using project configuration from ${projectPath}`);
          } else {
            logger.debug(`No HTMLHint project configuration found in ${projectPath}, using embedded defaults`);
          }
        } catch (configError) {
          logger.warn(`Failed to load HTMLHint project configuration: ${configError.message}, falling back to embedded defaults`);
        }
      }

      // Use HTMLHint with determined configuration
      let messages;
      try {
        // Log the exact parameters being passed to HTMLHint.verify
        logger.debug(`HTMLHint.verify called with:`, {
          codeContentType: typeof codeContent,
          codeContentLength: codeContent ? codeContent.length : 'null/undefined',
          ruleSetType: typeof ruleSet,
          ruleSetValue: ruleSet,
          configSource: configSource
        });

        // Test with simplified HTML first to isolate the issue
        if (!ruleSet) {
          logger.debug('Testing HTMLHint.verify with minimal HTML and no rules...');
          try {
            const testResult = HTMLHint.verify('<!DOCTYPE html><html><head><title>T</title></head><body></body></html>', undefined);
            logger.debug('Minimal HTML test result:', { type: typeof testResult, isArray: Array.isArray(testResult), value: testResult });
          } catch (testError) {
            logger.error('Minimal HTML test failed:', testError);
          }

          // Try with empty object instead of undefined/null
          logger.debug('Testing HTMLHint.verify with empty rules object...');
          try {
            const testResult2 = HTMLHint.verify('<!DOCTYPE html><html><head><title>T</title></head><body></body></html>', {});
            logger.debug('Empty rules object test result:', { type: typeof testResult2, isArray: Array.isArray(testResult2), value: testResult2 });
          } catch (testError2) {
            logger.error('Empty rules object test failed:', testError2);
          }
        }

        // Determine the safest way to call HTMLHint.verify for defaults
        let actualRuleSet = ruleSet;
        if (!ruleSet) {
          // Instead of passing null/undefined, try using a minimal default ruleset
          // This bypasses HTMLHint's potentially problematic internal default handling
          actualRuleSet = {
            'tag-pair': true,
            'tagname-lowercase': true,
            'attr-lowercase': true,
            'attr-value-double-quotes': true,
            'doctype-first': true,
            'id-unique': true,
            'src-not-empty': true,
            'title-require': true
          };
          logger.debug('Using fallback minimal default ruleset instead of HTMLHint internal defaults');
        }

        // Call HTMLHint.verify with the determined ruleset
        messages = HTMLHint.verify(codeContent, actualRuleSet);
        
        // Ensure messages is an array before processing
        if (!Array.isArray(messages)) {
          logger.warn(`HTMLHint.verify returned non-array result: ${typeof messages}, value: ${messages}`);
          messages = [];
        }

        logger.debug(`HTMLHint.verify completed successfully. Messages count: ${messages.length}`);
        
      } catch (verifyError) {
        // Log the complete error object including stack trace
        logger.error('HTMLHint.verify CRASHED:', {
          message: verifyError.message,
          stack: verifyError.stack,
          name: verifyError.name,
          ruleSetUsed: ruleSet,
          configSource: configSource
        });
        
        return this._createErrorResult(`HTMLHint verification failed: ${verifyError.message}`, languageHint, filePath);
      }

      // Process and standardize the results
      return this._processHTMLHintResults(messages, languageHint, filePath, codeContent, applyFixes);

    } catch (error) {
      logger.error(`HTMLHint error: ${error.message}`);
      return this._createErrorResult(`HTMLHint failed: ${error.message}`, languageHint, filePath);
    }
  }

  /**
   * Process HTMLHint results into standardized format
   */
  _processHTMLHintResults(messages, languageHint, filePath, originalCodeContent, applyFixes = false) {
    const diagnostics = [];
    let errorCount = 0;
    let warningCount = 0;

    // Validate that messages is an array before processing
    if (!Array.isArray(messages)) {
      logger.warn(`HTMLHint messages is not an array: ${typeof messages}, value: ${messages}`);
      return {
        linterUsed: 'htmlhint',
        filePathProvided: filePath,
        languageHintProvided: languageHint,
        fixedCodeContent: originalCodeContent,
        fixesAppliedCount: 0,
        originalDiagnostics: [],
        remainingDiagnostics: [],
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        isSuccess: true
      };
    }

    for (const message of messages) {
      // Map HTMLHint message to standardized format
      const diagnostic = {
        severity: this._mapHTMLHintSeverity(message.type),
        message: message.message,
        ruleId: message.rule?.id || 'unknown',
        line: message.line || 1,
        column: message.col || 1
      };

      // Calculate end position based on the raw content if available
      if (message.raw) {
        // For HTMLHint, we'll estimate end position based on the raw content length
        const rawLength = message.raw.length;
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column + rawLength;
      } else {
        // If no raw content, set end position same as start
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column;
      }

      diagnostics.push(diagnostic);

      if (diagnostic.severity === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }

    return {
      linterUsed: 'htmlhint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent: originalCodeContent,
      fixesAppliedCount: 0, // HTMLHint doesn't support fixing
      originalDiagnostics: diagnostics,
      remainingDiagnostics: diagnostics,
      diagnostics,
      errorCount,
      warningCount,
      isSuccess: true
    };
  }

  /**
   * Map HTMLHint severity to standardized severity
   * HTMLHint uses 'error', 'warning', 'info' types
   */
  _mapHTMLHintSeverity(type) {
    switch (type) {
      case 'error':
        return 'error';
      case 'warning':
      case 'info':
      default:
        return 'warning';
    }
  }

  /**
   * Create standardized error result
   */
  _createErrorResult(errorMessage, languageHint, filePath) {
    return {
      linterUsed: 'htmlhint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: errorMessage
    };
  }

  /**
   * Load project-specific HTMLHint configuration from .htmlhintrc
   * @param {string} projectPath - Absolute path to the project root
   * @returns {Object|null} Parsed HTMLHint configuration or null if not found
   */
  _loadProjectConfig(projectPath) {
    try {
      // Search for .htmlhintrc file in the project path
      const htmlhintrcPath = path.join(projectPath, '.htmlhintrc');
      if (fs.existsSync(htmlhintrcPath)) {
        logger.debug(`Found .htmlhintrc at ${htmlhintrcPath}`);
        const configContent = fs.readFileSync(htmlhintrcPath, 'utf8');
        
        try {
          // Parse the JSON content
          const parsedConfig = JSON.parse(configContent);
          logger.debug('Successfully parsed .htmlhintrc configuration:', JSON.stringify(parsedConfig, null, 2));
          return parsedConfig;
        } catch (parseError) {
          logger.warn(`Failed to parse .htmlhintrc as JSON: ${parseError.message}`);
          throw new Error(`Invalid JSON in .htmlhintrc: ${parseError.message}`);
        }
      }

      // No configuration file found
      logger.debug(`No .htmlhintrc file found in ${projectPath}`);
      return null;

    } catch (error) {
      logger.warn(`Error loading HTMLHint project configuration: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Markdownlint integration for the unified lint_code tool
 * Supports Markdown code linting
 */
class MarkdownlintTool {
  static supportsFixing = true;

  constructor() {
    this.name = 'markdownlint';
    this.supportedLanguages = ['markdown'];
  }

  /**
   * Lint Markdown code using markdownlint
   * @param {string} codeContent - The Markdown code to lint
   * @param {string} languageHint - Language hint (should be 'markdown')
   * @param {string} filePath - Optional file path for context
   * @param {string} projectPath - Optional absolute path to the project root
   * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
   * @param {boolean} applyFixes - Whether to apply automatic fixes (default: false)
   * @returns {Object} Standardized lint result with fixing support
   */
  async lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
    try {
      const markdownlint = await getMarkdownlintSync();

      // Validate inputs
      if (!codeContent || typeof codeContent !== 'string') {
        return this._createErrorResult('Invalid code content provided', languageHint, filePath);
      }

      if (!this.supportedLanguages.includes(languageHint)) {
        return this._createErrorResult(`Unsupported language hint: ${languageHint}`, languageHint, filePath);
      }

      // Determine markdownlint configuration to use
      let config = null;
      let configSource = 'embedded-defaults';
      
      if (useProjectConfig && projectPath && typeof projectPath === 'string' && projectPath.trim() !== '') {
        try {
          const projectConfig = this._loadProjectConfig(projectPath);
          if (projectConfig) {
            config = projectConfig;
            configSource = 'project-config';
            logger.debug(`Markdownlint using project configuration from ${projectPath}`);
          } else {
            logger.debug(`No Markdownlint project configuration found in ${projectPath}, using embedded defaults`);
          }
        } catch (configError) {
          logger.warn(`Failed to load Markdownlint project configuration: ${configError.message}, falling back to embedded defaults`);
        }
      }

      // Prepare markdownlint options
      let options;
      
      if (config) {
        // Use project-specific configuration
        options = {
          strings: {
            content: codeContent
          },
          config: config
        };
        logger.debug(`Markdownlint using project config: ${JSON.stringify(config)}`);
      } else {
        // Use enhanced embedded default configuration for better autofixing
        const enhancedConfig = this._createEnhancedMarkdownlintConfig();
        options = {
          strings: {
            content: codeContent
          },
          config: enhancedConfig
        };
        logger.debug('Markdownlint using enhanced embedded default configuration');
      }

      // Handle fixing logic
      if (applyFixes && MarkdownlintTool.supportsFixing) {
        // Get original diagnostics first
        const originalResult = markdownlint.sync(options);

        // Apply fixes using our custom fix helper
        let fixedCodeContent = codeContent;
        try {
          // Import our custom fix helper
          const { applyMarkdownlintFixes } = require('../../../../markdownlint_fix_helper');
          
          // Extract errors with fix information
          let errors = [];
          if (originalResult.content) {
            errors = originalResult.content;
          } else {
            const resultKeys = Object.keys(originalResult);
            if (resultKeys.length > 0) {
              errors = originalResult[resultKeys[0]] || [];
            }
          }

          // Apply fixes using our custom helper
          fixedCodeContent = applyMarkdownlintFixes(codeContent, errors);
          
        } catch (helpersError) {
          logger.warn(`Custom markdownlint fix helper error: ${helpersError.message}`);
          // If fix helper fails, try markdownlint's built-in fix option
          try {
            const fixOptions = { ...options, fix: true };
            const builtInFixResult = markdownlint.sync(fixOptions);
            // markdownlint doesn't return fixed content directly, so we'll use our helper as fallback
            fixedCodeContent = codeContent;
          } catch (builtInError) {
            logger.warn(`Built-in markdownlint fix also failed: ${builtInError.message}`);
            fixedCodeContent = codeContent;
          }
        }

        // Re-lint the fixed content to get remaining diagnostics
        let remainingResult;
        if (fixedCodeContent !== codeContent) {
          const fixedOptions = {
            ...options,
            strings: {
              content: fixedCodeContent
            }
          };
          remainingResult = markdownlint.sync(fixedOptions);
        } else {
          remainingResult = originalResult;
        }

        // Process results with fixing information
        return this._processMarkdownlintResultsWithFixes(originalResult, remainingResult, languageHint, filePath, codeContent, fixedCodeContent);
      } else {
        // Standard linting without fixes
        const result = markdownlint.sync(options);

        // Process and standardize the results
        return this._processMarkdownlintResults(result, languageHint, filePath, codeContent, false);
      }

    } catch (error) {
      logger.error(`Markdownlint error: ${error.message}`);
      return this._createErrorResult(`Markdownlint failed: ${error.message}`, languageHint, filePath);
    }
  }

  /**
   * Process markdownlint results into standardized format
   */
  _processMarkdownlintResults(result, languageHint, filePath, originalCodeContent, isFixed = false) {
    const diagnostics = [];
    let errorCount = 0;
    let warningCount = 0;

    // markdownlint returns results with the key being the string name or file path
    // For string-based linting, the key is 'content' or the contextFilePath
    // For file-based linting, the key is the actual file path
    let errors = [];
    
    if (result.content) {
      // String-based linting with 'content' key
      errors = result.content;
    } else {
      // File-based linting or string-based with contextFilePath
      // Find the first (and usually only) key in the result object
      const resultKeys = Object.keys(result);
      if (resultKeys.length > 0) {
        errors = result[resultKeys[0]] || [];
      }
    }

    for (const error of errors) {
      // Map markdownlint error to standardized format
      const diagnostic = {
        severity: 'error', // markdownlint typically reports errors
        message: error.ruleDescription || error.errorDetail || 'Markdown linting error',
        ruleId: error.ruleNames && error.ruleNames.length > 0 ? error.ruleNames[0] : 'unknown',
        line: error.lineNumber || 1,
        column: error.errorRange && error.errorRange.length > 0 ? error.errorRange[0] : 1
      };

      // Add end position if available
      if (error.errorRange && error.errorRange.length >= 2) {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column + error.errorRange[1] - 1;
      } else {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column;
      }

      // Add additional context if available
      if (error.errorContext) {
        diagnostic.message += ` (Context: ${error.errorContext})`;
      }

      diagnostics.push(diagnostic);

      if (diagnostic.severity === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }

    const resultObj = {
      linterUsed: 'markdownlint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics,
      errorCount,
      warningCount,
      isSuccess: true
    };

    // Add fixing-related fields
    resultObj.fixedCodeContent = originalCodeContent;
    resultObj.fixesAppliedCount = 0;
    resultObj.originalDiagnostics = diagnostics;
    resultObj.remainingDiagnostics = diagnostics;

    return resultObj;
  }

  /**
   * Process markdownlint results with fixing information
   */
  _processMarkdownlintResultsWithFixes(originalResult, remainingResult, languageHint, filePath, originalCodeContent, fixedCodeContent) {
    const originalDiagnostics = [];
    const remainingDiagnostics = [];
    let originalErrorCount = 0;
    let originalWarningCount = 0;
    let remainingErrorCount = 0;
    let remainingWarningCount = 0;

    // Process original diagnostics
    let originalErrors = [];
    if (originalResult.content) {
      originalErrors = originalResult.content;
    } else {
      const resultKeys = Object.keys(originalResult);
      if (resultKeys.length > 0) {
        originalErrors = originalResult[resultKeys[0]] || [];
      }
    }

    for (const error of originalErrors) {
      const diagnostic = {
        severity: 'error',
        message: error.ruleDescription || error.errorDetail || 'Markdown linting error',
        ruleId: error.ruleNames && error.ruleNames.length > 0 ? error.ruleNames[0] : 'unknown',
        line: error.lineNumber || 1,
        column: error.errorRange && error.errorRange.length > 0 ? error.errorRange[0] : 1
      };

      if (error.errorRange && error.errorRange.length >= 2) {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column + error.errorRange[1] - 1;
      } else {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column;
      }

      if (error.errorContext) {
        diagnostic.message += ` (Context: ${error.errorContext})`;
      }

      originalDiagnostics.push(diagnostic);
      originalErrorCount++;
    }

    // Process remaining diagnostics
    let remainingErrors = [];
    if (remainingResult.content) {
      remainingErrors = remainingResult.content;
    } else {
      const resultKeys = Object.keys(remainingResult);
      if (resultKeys.length > 0) {
        remainingErrors = remainingResult[resultKeys[0]] || [];
      }
    }

    for (const error of remainingErrors) {
      const diagnostic = {
        severity: 'error',
        message: error.ruleDescription || error.errorDetail || 'Markdown linting error',
        ruleId: error.ruleNames && error.ruleNames.length > 0 ? error.ruleNames[0] : 'unknown',
        line: error.lineNumber || 1,
        column: error.errorRange && error.errorRange.length > 0 ? error.errorRange[0] : 1
      };

      if (error.errorRange && error.errorRange.length >= 2) {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column + error.errorRange[1] - 1;
      } else {
        diagnostic.endLine = diagnostic.line;
        diagnostic.endColumn = diagnostic.column;
      }

      if (error.errorContext) {
        diagnostic.message += ` (Context: ${error.errorContext})`;
      }

      remainingDiagnostics.push(diagnostic);
      remainingErrorCount++;
    }

    // Calculate fixes applied count
    const fixesAppliedCount = Math.max(0, originalDiagnostics.length - remainingDiagnostics.length);

    return {
      linterUsed: 'markdownlint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent,
      fixesAppliedCount,
      originalDiagnostics,
      remainingDiagnostics,
      diagnostics: remainingDiagnostics, // For backward compatibility
      errorCount: remainingErrorCount,
      warningCount: remainingWarningCount,
      isSuccess: true
    };
  }

  /**
   * Load project-specific Markdownlint configuration from .markdownlint.jsonc or .markdownlint.json
   * @param {string} projectPath - Absolute path to the project root
   * @returns {Object|null} Parsed Markdownlint configuration or null if not found
   */
  _loadProjectConfig(projectPath) {
    try {
      // First, try to find .markdownlint.jsonc
      const markdownlintJsoncPath = path.join(projectPath, '.markdownlint.jsonc');
      if (fs.existsSync(markdownlintJsoncPath)) {
        logger.debug(`Found .markdownlint.jsonc at ${markdownlintJsoncPath}`);
        const configContent = fs.readFileSync(markdownlintJsoncPath, 'utf8');
        
        try {
          // Parse JSONC content
          let parsedConfig;
          if (jsoncParser) {
            // Use jsonc-parser if available for proper JSONC parsing
            parsedConfig = jsoncParser.parse(configContent);
          } else {
            // Fallback to JSON.parse (may fail on comments)
            parsedConfig = JSON.parse(configContent);
          }
          
          logger.debug('Successfully parsed .markdownlint.jsonc configuration:', JSON.stringify(parsedConfig, null, 2));
          return parsedConfig;
        } catch (parseError) {
          logger.warn(`Failed to parse .markdownlint.jsonc: ${parseError.message}`);
          throw new Error(`Invalid JSONC in .markdownlint.jsonc: ${parseError.message}`);
        }
      }

      // If .markdownlint.jsonc not found, try .markdownlint.json
      const markdownlintJsonPath = path.join(projectPath, '.markdownlint.json');
      if (fs.existsSync(markdownlintJsonPath)) {
        logger.debug(`Found .markdownlint.json at ${markdownlintJsonPath}`);
        const configContent = fs.readFileSync(markdownlintJsonPath, 'utf8');
        
        try {
          // Parse JSON content
          const parsedConfig = JSON.parse(configContent);
          logger.debug('Successfully parsed .markdownlint.json configuration:', JSON.stringify(parsedConfig, null, 2));
          return parsedConfig;
        } catch (parseError) {
          logger.warn(`Failed to parse .markdownlint.json: ${parseError.message}`);
          throw new Error(`Invalid JSON in .markdownlint.json: ${parseError.message}`);
        }
      }

      // No configuration files found
      logger.debug(`No Markdownlint configuration files found in ${projectPath}`);
      return null;

    } catch (error) {
      logger.warn(`Error loading Markdownlint project configuration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create enhanced markdownlint configuration for better autofixing
   * @returns {Object} Enhanced markdownlint configuration
   */
  _createEnhancedMarkdownlintConfig() {
    return {
      // Enable commonly fixable rules
      "MD001": true,  // heading-increment - Heading levels should only increment by one level at a time
      "MD003": { "style": "atx" }, // heading-style - Heading style should be consistent
      "MD004": { "style": "dash" }, // ul-style - Unordered list style should be consistent
      "MD005": true,  // list-indent - Inconsistent indentation for list items at the same level
      "MD007": { "indent": 2 }, // ul-indent - Unordered list indentation should be consistent
      "MD009": true,  // no-trailing-spaces - Trailing spaces are not allowed
      "MD010": true,  // no-hard-tabs - Hard tabs are not allowed
      "MD011": true,  // no-reversed-links - Reversed link syntax
      "MD012": { "maximum": 1 }, // no-multiple-blanks - Multiple consecutive blank lines
      "MD014": true,  // commands-show-output - Dollar signs used before commands without showing output
      "MD018": true,  // no-missing-space-atx - No space after hash on atx style heading
      "MD019": true,  // no-multiple-space-atx - Multiple spaces after hash on atx style heading
      "MD020": true,  // no-missing-space-closed-atx - No space inside hashes on closed atx style heading
      "MD021": true,  // no-multiple-space-closed-atx - Multiple spaces inside hashes on closed atx style heading
      "MD022": true,  // blanks-around-headings - Headings should be surrounded by blank lines
      "MD023": true,  // heading-start-left - Headings must start at the beginning of the line
      "MD026": true,  // no-trailing-punctuation - Trailing punctuation in heading
      "MD027": true,  // no-multiple-space-blockquote - Multiple spaces after blockquote symbol
      "MD028": true,  // no-blanks-blockquote - Blank line inside blockquote
      "MD029": { "style": "ordered" }, // ol-prefix - Ordered list item prefix should be consistent
      "MD030": true,  // list-marker-space - Spaces after list markers
      "MD031": true,  // blanks-around-fences - Fenced code blocks should be surrounded by blank lines
      "MD032": true,  // blanks-around-lists - Lists should be surrounded by blank lines
      "MD034": true,  // no-bare-urls - Bare URL used
      "MD037": true,  // no-space-in-emphasis - Spaces inside emphasis markers
      "MD038": true,  // no-space-in-code - Spaces inside code span elements
      "MD039": true,  // no-space-in-links - Spaces inside link text
      "MD044": true,  // proper-names - Proper names should have the correct capitalization
      "MD047": true,  // single-trailing-newline - Files should end with a single newline character
      "MD049": { "style": "underscore" }, // emphasis-style - Emphasis style should be consistent
      "MD050": { "style": "asterisk" }, // strong-style - Strong style should be consistent
      
      // Disable rules that might be too strict or not fixable
      "MD013": false, // line-length - Line length (often not auto-fixable in meaningful way)
      "MD041": false, // first-line-heading - First line in file should be a top level heading (often not desired)
      "MD033": false, // no-inline-html - Inline HTML (often intentional)
      "MD040": false, // fenced-code-language - Fenced code blocks should have a language specified (not always fixable)
    };
  }

  /**
   * Create standardized error result
   */
  _createErrorResult(errorMessage, languageHint, filePath) {
    return {
      linterUsed: 'markdownlint',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: errorMessage
    };
  }
}

/**
 * Helper function to get a safe temporary directory for linting operations
 * @param {string|null} projectPath - The project path (may be null for default linting)
 * @param {boolean} useProjectConfig - Whether project config is being used
 * @returns {string|null} Safe directory path or null for default behavior
 */
function getSafeLintingDirectory(projectPath, useProjectConfig) {
  // If useProjectConfig is false, always return null to force default config usage
  if (!useProjectConfig) {
    logger.debug('getSafeLintingDirectory: useProjectConfig=false, returning null for default config');
    return null;
  }
  
  // If useProjectConfig is true but projectPath is null/invalid, use system temp directory
  if (!projectPath || typeof projectPath !== 'string' || projectPath.trim() === '') {
    const tempDir = os.tmpdir();
    logger.debug(`getSafeLintingDirectory: projectPath invalid, using system temp directory: ${tempDir}`);
    return tempDir;
  }
  
  // If both useProjectConfig is true and projectPath is valid, use the project path
  logger.debug(`getSafeLintingDirectory: using project path: ${projectPath}`);
  return projectPath;
}

/**
 * Main lint_code tool function
 * Dispatches to appropriate linter based on language hint
 * @param {string} codeContent - The code to lint
 * @param {string} languageHint - Language hint (e.g., 'javascript', 'typescript', 'python')
 * @param {string} filePath - Optional file path for context
 * @param {string} projectPath - Optional absolute path to the project root (null for default config)
 * @param {boolean} useProjectConfig - Whether to use project-specific configuration (default: true)
 * @param {boolean} applyFixes - Whether to apply automatic fixes (default: false)
 */
async function lintCode(codeContent, languageHint, filePath = null, projectPath = null, useProjectConfig = true, applyFixes = false) {
  try {
    // Log the input parameters for debugging
    logger.debug('lintCode called with:', {
      languageHint,
      filePath,
      projectPath,
      useProjectConfig,
      applyFixes,
      codeContentLength: codeContent ? codeContent.length : 'null/undefined'
    });

    // Validate required parameters
    if (!codeContent) {
      throw new Error('codeContent parameter is required');
    }
    if (!languageHint) {
      throw new Error('languageHint parameter is required');
    }

    // Get the safe directory for linting operations
    const safeLintingDirectory = getSafeLintingDirectory(projectPath, useProjectConfig);
    
    logger.debug('lintCode: safeLintingDirectory determined as:', safeLintingDirectory);

    // Initialize linter tools
    const eslintTool = new ESLintTool();
    const ruffTool = new RuffTool();
    const stylelintTool = new StylelintTool();
    const htmlhintTool = new HTMLHintTool();
    const markdownlintTool = new MarkdownlintTool();

    // Check if ESLint supports this language
    if (eslintTool.supportedLanguages.includes(languageHint)) {
      return await eslintTool.lintCode(codeContent, languageHint, filePath, safeLintingDirectory, useProjectConfig, applyFixes);
    }

    // Check if Ruff supports this language
    if (ruffTool.supportedLanguages.includes(languageHint)) {
      return await ruffTool.lintCode(codeContent, languageHint, filePath, safeLintingDirectory, useProjectConfig, applyFixes);
    }

    // Check if Stylelint supports this language
    if (stylelintTool.supportedLanguages.includes(languageHint)) {
      return await stylelintTool.lintCode(codeContent, languageHint, filePath, safeLintingDirectory, useProjectConfig, applyFixes);
    }

    // Check if HTMLHint supports this language
    if (htmlhintTool.supportedLanguages.includes(languageHint)) {
      return await htmlhintTool.lintCode(codeContent, languageHint, filePath, safeLintingDirectory, useProjectConfig, applyFixes);
    }

    // Check if Markdownlint supports this language
    if (markdownlintTool.supportedLanguages.includes(languageHint)) {
      return await markdownlintTool.lintCode(codeContent, languageHint, filePath, safeLintingDirectory, useProjectConfig, applyFixes);
    }

    // If no linter supports this language, return appropriate error
    return {
      linterUsed: 'none',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent: codeContent,
      fixesAppliedCount: 0,
      originalDiagnostics: [],
      remainingDiagnostics: [],
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: `No linter available for language: ${languageHint}`
    };

  } catch (error) {
    logger.error(`lint_code tool error: ${error.message}`);
    return {
      linterUsed: 'none',
      filePathProvided: filePath,
      languageHintProvided: languageHint,
      fixedCodeContent: codeContent || '',
      fixesAppliedCount: 0,
      originalDiagnostics: [],
      remainingDiagnostics: [],
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      isSuccess: false,
      linterInternalError: error.message
    };
  }
}

module.exports = {
  lintCode,
  ESLintTool,
  RuffTool,
  StylelintTool,
  HTMLHintTool,
  MarkdownlintTool
};
