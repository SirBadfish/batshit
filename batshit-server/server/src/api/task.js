const express = require('express');
const path = require('path');
const router = express.Router();
const logger = require('../utils/logger');
const { builtInService } = require('../services');

// The official built-in tool surface (the documented BSn tool set). Dispatch
// is restricted to these names so a caller can never reach arbitrary service
// methods or internal helpers through the snake_case→camelCase conversion.
const BUILT_IN_TOOL_ALLOW_LIST = new Set([
  'read_file',
  'write_file',
  'create_file',
  'delete_file',
  'rename_file',
  'copy_file',
  'get_file_info',
  'list_files',
  'search_files',
  'find_files',
  'analyze_structure',
  'count_lines_of_code',
  'analyze_imports',
  'analyze_dependencies',
  'git_status',
  'git_diff',
  'git_branches',
  'format_code',
  'validate_syntax',
  'lint_code',
  'execute_command',
  'get_environment_info',
  'check_installation',
]);

/**
 * POST /api/v1/task/s
 * Start a new task
 *
 * Expected body structure:
 * {
 *   serviceName: 'built-in',
 *   toolName: string,
 *   input: object,
 *   params: object
 * }
 */
router.post('/s', async (req, res) => {
  try {
    const { serviceName, toolName, input, params = {} } = req.body;

    logger.info(`Task request received - Service: ${serviceName}, Tool: ${toolName}`);

    if (serviceName !== 'built-in') {
      return res.status(400).json({
        error: `Unknown service: ${serviceName}. Available services: built-in`
      });
    }

    // Handle session management
    const sessionId = params.sessionId || `${serviceName}-temp-${Date.now()}`;
    const projectPath = params.projectPath ||
      process.env.BATSHIT_PROJECT_ROOT ||
      path.resolve(__dirname, '../../../..');

    let result;

    if (typeof toolName !== 'string' || !BUILT_IN_TOOL_ALLOW_LIST.has(toolName)) {
      return res.status(404).json({
        error: `Tool "${toolName}" not found in built-in service`
      });
    }

    // Convert snake_case to camelCase (e.g., read_file -> readFile)
    const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (typeof builtInService[methodName] !== 'function') {
      return res.status(404).json({
        error: `Tool "${toolName}" not found in built-in service`
      });
    }

    result = await builtInService[methodName](projectPath, input);

    // Ensure sessionId and projectPath are in the response
    const response = {
      success: true,
      ...result,
      sessionId,
      projectPath,
      status: 'completed'
    };

    res.json(response);

  } catch (error) {
    logger.error('Task execution error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorMessage: error.message
    });
  }
});

/**
 * GET /api/v1/task/:taskId
 * Get task status (simplified - no real async tracking for now)
 */
router.get('/:taskId', async (req, res) => {
  const { taskId } = req.params;

  // For now, all tasks complete immediately
  res.json({
    taskId,
    status: 'completed',
    message: 'Task completed'
  });
});

module.exports = router;
