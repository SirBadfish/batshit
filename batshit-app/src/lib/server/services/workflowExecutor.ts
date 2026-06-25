/**
 * Workflow Executor Service for Mode 3
 * Story 5.11: Executes n8n workflows via webhook calls
 *
 * CRITICAL: Proper timeout cleanup (PERF-001)
 * CRITICAL: Include authentication headers (SEC-001)
 * CRITICAL: Never log webhook URLs (SEC-001)
 */

import { logger } from '$lib/utils/logger'
import type { WorkflowInfo } from './workflowDiscovery'
import { detectAsyncWorkflow, executeAsyncWorkflow } from './workflowAsyncHandler'
import type { WorkflowExecutionOptions, WorkflowExecutionResult } from './workflowExecutionTypes'

export type { WorkflowExecutionOptions, WorkflowExecutionResult } from './workflowExecutionTypes'

/**
 * Execute workflow via webhook
 * CRITICAL: This addresses risks PERF-001 and SEC-001
 */
export async function callWorkflow(
  workflow: WorkflowInfo,
  args: any,
  options: WorkflowExecutionOptions = {}
): Promise<WorkflowExecutionResult> {
  const startTime = Date.now()
  const {
    timeout = 30000,
    sessionId,
    userId,
    retries = 0,
    async = options.async,
    abortSignal
  } = options

  // Never log the full webhook URL
  logger.debug('[WorkflowExecutor] Executing workflow', {
    name: workflow.name,
    sessionId: sessionId?.substring(0, 8),
    hasArgs: !!args
  })

  // Validate webhook URL exists
  if (!workflow.webhookUrl) {
    return {
      success: false,
      error: 'Workflow has no webhook URL configured',
      workflowName: workflow.name,
      executionTime: Date.now() - startTime
    }
  }

  // Check if workflow uses async pattern
  const isAsync = async !== false && detectAsyncWorkflow(workflow)

  if (isAsync) {
    logger.debug('[WorkflowExecutor] Detected async workflow, using async handler')
    return executeAsyncWorkflow(workflow, args, {
      sessionId,
      userId,
      timeout: timeout * 2, // Double timeout for async workflows
      abortSignal
    })
  }

  // Prepare request with timeout
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const abortFromCaller = () => controller.abort()
  if (abortSignal?.aborted) {
    controller.abort()
  } else {
    abortSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }

  try {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'X-Source': 'batshit-mode-3'
    }

    // Add tracking headers
    if (sessionId) {
      headers['X-Session-ID'] = sessionId
    }
    if (userId) {
      headers['X-User-ID'] = userId
    }

    // Execute webhook
    const response = await fetch(workflow.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...args,
        sessionId,
        _meta: {
          source: 'batshit-mode-3',
          userId,
          workflowId: workflow.id,
          timestamp: new Date().toISOString()
        }
      }),
      signal: controller.signal
    })

    // Handle response
    if (!response.ok) {
      const errorText = await response.text()
      throw new WorkflowExecutionError(
        response.status,
        response.statusText,
        errorText
      )
    }

    // Parse response
    const result = await parseWorkflowResponse(response)

    logger.debug('[WorkflowExecutor] Workflow executed successfully', {
      name: workflow.name,
      executionTime: Date.now() - startTime
    })

    return {
      success: true,
      data: result,
      workflowName: workflow.name,
      executionTime: Date.now() - startTime,
      method: 'webhook'
    }
  } catch (error: any) {
    // Handle specific error types
    if (error.name === 'AbortError') {
      if (abortSignal?.aborted && !timedOut) {
        logger.debug('[WorkflowExecutor] Workflow cancelled', {
          name: workflow.name
        })

        return {
          success: false,
          timeout: false,
          error: `The workflow '${workflow.name}' was cancelled.`,
          workflowName: workflow.name,
          executionTime: Date.now() - startTime
        }
      }

      logger.debug('[WorkflowExecutor] Workflow timed out', {
        name: workflow.name,
        timeout
      })

      return {
        success: false,
        timeout: true,
        error: formatTimeoutError(workflow.name, timeout),
        workflowName: workflow.name,
        executionTime: Date.now() - startTime
      }
    }

    // Handle workflow execution errors
    if (error instanceof WorkflowExecutionError) {
      console.error('[WorkflowExecutor] Workflow error', {
        name: workflow.name,
        status: error.status
      })

      return {
        success: false,
        error: formatWorkflowError(error),
        workflowName: workflow.name,
        executionTime: Date.now() - startTime
      }
    }

    // Handle network errors with retry
    if (retries > 0 && isRetryableError(error)) {
      logger.debug('[WorkflowExecutor] Retrying workflow', {
        name: workflow.name,
        retriesLeft: retries - 1
      })

      const retryDelayMs = Math.min(10_000, 1000 * 2 ** Math.max(0, retries - 1))
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))

      return callWorkflow(workflow, args, {
        ...options,
        retries: retries - 1
      })
    }

    // Generic error
    console.error('[WorkflowExecutor] Unexpected error', {
      name: workflow.name,
      error: error.message
    })

    return {
      success: false,
      error: formatGenericError(error),
      workflowName: workflow.name,
      executionTime: Date.now() - startTime
    }
  } finally {
    clearTimeout(timeoutId)
    abortSignal?.removeEventListener('abort', abortFromCaller)
  }
}

/**
 * Parse workflow response
 * Ensures consistent format for AI consumption
 */
async function parseWorkflowResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type')

  if (contentType?.includes('application/json')) {
    const data = await response.json()

    // Ensure consistent return format
    if (typeof data === 'object' && data !== null) {
      return data
    }

    // Wrap primitives in object
    return { value: data }
  }

  // Handle text responses
  const text = await response.text()
  return { value: text, type: 'text' }
}

/**
 * Format timeout error for AI understanding
 */
function formatTimeoutError(workflowName: string, timeout: number): string {
  const seconds = Math.round(timeout / 1000)
  return `The workflow '${workflowName}' took longer than ${seconds} seconds to complete. Try with simpler parameters or check if the workflow is running correctly.`
}

/**
 * Format workflow execution error for AI
 */
function formatWorkflowError(error: WorkflowExecutionError): string {
  switch (error.status) {
    case 400:
      return 'Invalid parameters provided. Check the expected format and try again.'
    case 401:
      return 'Authentication failed. The workflow requires valid credentials.'
    case 403:
      return 'Access denied. You do not have permission to execute this workflow.'
    case 404:
      return 'The workflow is not available. It may be deactivated or deleted.'
    case 429:
      return 'Rate limit exceeded. Please wait before trying again.'
    case 500:
      return 'The workflow encountered an internal error. Try again later.'
    case 503:
      return 'The workflow service is temporarily unavailable. Try again in a few moments.'
    default:
      return `The workflow failed with status ${error.status}. ${error.statusText || 'Please try again.'}`
  }
}

/**
 * Format generic error for AI
 */
function formatGenericError(error: any): string {
  if (error.code === 'ECONNREFUSED') {
    return 'Cannot connect to the workflow service. Please check if n8n is running.'
  }

  if (error.code === 'ETIMEDOUT') {
    return 'Connection to workflow service timed out. The service may be overloaded.'
  }

  return 'The workflow encountered an unexpected error. Please try again or use a different approach.'
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: any): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true
  }

  // Specific HTTP status codes
  if (error instanceof WorkflowExecutionError) {
    return error.status === 429 || error.status === 503
  }

  return false
}

/**
 * Custom error class for workflow execution
 */
class WorkflowExecutionError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    super(`Workflow failed: ${status} ${statusText}`)
    this.name = 'WorkflowExecutionError'
  }
}
