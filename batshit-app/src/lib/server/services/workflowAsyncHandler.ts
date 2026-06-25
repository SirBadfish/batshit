/**
 * Async Workflow Handler for Mode 3
 * Story 5.11: Handles async workflows with "Respond to Webhook" pattern
 *
 * CRITICAL: Support for long-running workflows (TECH-002)
 * CRITICAL: Polling and callback mechanisms
 * CRITICAL: Proper cleanup and timeout handling
 */

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import type { WorkflowInfo } from './workflowDiscovery'
import type { WorkflowExecutionResult } from './workflowExecutionTypes'

/**
 * Async workflow execution state
 */
interface AsyncWorkflowState {
  executionId: string
  workflowId: string
  workflowName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  result?: any
  error?: string
  startTime: number
  lastPoll?: number
  callbackUrl?: string
}

/**
 * Detect if workflow uses async "Respond to Webhook" pattern
 */
export function detectAsyncWorkflow(workflow: WorkflowInfo): boolean {
  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    return false
  }

  // Look for "Respond to Webhook" node
  const hasRespondNode = workflow.nodes.some(node =>
    node.type === 'n8n-nodes-base.respondToWebhook' ||
    node.type === '@n8n/n8n-nodes-base.respondToWebhook' ||
    node.type?.includes('respondToWebhook')
  )

  // Also check for specific webhook settings
  const webhookNode = workflow.nodes.find(n => n.type?.includes('webhook'))
  const hasWaitMode = webhookNode?.parameters?.responseMode === 'lastNode'

  return hasRespondNode || hasWaitMode
}

/**
 * Execute async workflow with callback pattern
 */
export async function executeAsyncWorkflow(
  workflow: WorkflowInfo,
  args: any,
  options: {
    sessionId?: string
    userId?: string
    timeout?: number
    abortSignal?: AbortSignal
  } = {}
): Promise<WorkflowExecutionResult> {
  const executionId = generateExecutionId()
  const startTime = Date.now()
  const { timeout = 60000, sessionId, userId, abortSignal } = options // 60s default for async

  logger.debug('[AsyncHandler] Starting async workflow', {
    name: workflow.name,
    executionId
  })

  // Create execution state
  const state: AsyncWorkflowState = {
    executionId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'pending',
    startTime
  }

  // Store state in Redis
  await storeAsyncState(executionId, state)

  // Generate callback URL for workflow
  const callbackUrl = generateCallbackUrl(executionId)

  // Execute workflow with callback info
  const webhookPayload = {
    ...args,
    sessionId,
    _async: {
      executionId,
      callbackUrl,
      timeout
    },
    _meta: {
      source: 'batshit-mode-3-async',
      userId,
      timestamp: new Date().toISOString()
    }
  }

  try {
    if (abortSignal?.aborted) {
      throw new DOMException('Workflow cancelled', 'AbortError')
    }

    // Initial webhook call (returns immediately)
    const initController = new AbortController()
    const initTimeout = setTimeout(() => initController.abort(), 5000)
    const abortInitialCall = () => initController.abort()
    abortSignal?.addEventListener('abort', abortInitialCall, { once: true })
    let response: Response
    try {
      response = await fetch(workflow.webhookUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source': 'batshit-mode-3-async',
          'X-Execution-ID': executionId
        },
        body: JSON.stringify(webhookPayload),
        signal: initController.signal // Quick timeout for initial call
      })
    } finally {
      clearTimeout(initTimeout)
      abortSignal?.removeEventListener('abort', abortInitialCall)
    }

    if (!response.ok) {
      throw new Error(`Workflow initiation failed: ${response.status}`)
    }

    // Check if workflow returned immediate response
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength) > 2) {
      const immediateResult = await response.json()

      // If we got a full result, workflow wasn't actually async
      if (immediateResult && typeof immediateResult === 'object') {
        logger.debug('[AsyncHandler] Workflow returned immediate result')

        await updateAsyncState(executionId, {
          status: 'completed',
          result: immediateResult
        })

        return {
          success: true,
          data: immediateResult,
          workflowName: workflow.name,
          executionTime: Date.now() - startTime,
          method: 'webhook'
        }
      }
    }

    // Update state to running
    await updateAsyncState(executionId, { status: 'running' })

    // Start polling for result
    const result = await pollForResult(executionId, timeout, abortSignal)

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      timeout: result.timeout,
      workflowName: workflow.name,
      executionTime: Date.now() - startTime,
      method: 'async',
      executionId
    }
  } catch (error: any) {
    const cancelled = error?.name === 'AbortError' && abortSignal?.aborted
    console.error('[AsyncHandler] Async workflow error', {
      name: workflow.name,
      error: cancelled ? 'cancelled' : error.message
    })

    await updateAsyncState(executionId, {
      status: cancelled ? 'failed' : 'failed',
      error: cancelled ? 'Workflow cancelled' : error.message
    })

    return {
      success: false,
      error: cancelled
        ? `The workflow '${workflow.name}' was cancelled.`
        : `Async workflow failed: ${error.message}`,
      workflowName: workflow.name,
      executionTime: Date.now() - startTime,
      method: 'async',
      executionId
    }
  }
}

/**
 * Poll for async workflow result
 */
async function pollForResult(
  executionId: string,
  timeout: number,
  abortSignal?: AbortSignal
): Promise<{ success: boolean; data?: any; error?: string; timeout?: boolean }> {
  const startTime = Date.now()
  const pollInterval = 1000 // Poll every second
  const maxPolls = Math.ceil(timeout / pollInterval)

  logger.debug('[AsyncHandler] Polling for result', {
    executionId,
    maxPolls
  })

  for (let i = 0; i < maxPolls; i++) {
    if (abortSignal?.aborted) {
      await updateAsyncState(executionId, {
        status: 'failed',
        error: 'Workflow cancelled'
      })

      return {
        success: false,
        error: 'Workflow was cancelled'
      }
    }

    // Check execution state
    const state = await getAsyncState(executionId)

    if (!state) {
      return {
        success: false,
        error: 'Execution state lost'
      }
    }

    // Update last poll time
    await updateAsyncState(executionId, { lastPoll: Date.now() })

    // Check if completed
    if (state.status === 'completed') {
      logger.debug('[AsyncHandler] Workflow completed', {
        executionId,
        polls: i + 1
      })

      return {
        success: true,
        data: state.result
      }
    }

    // Check if failed
    if (state.status === 'failed') {
      return {
        success: false,
        error: state.error || 'Workflow execution failed'
      }
    }

    // Check timeout
    if (Date.now() - startTime > timeout) {
      await updateAsyncState(executionId, {
        status: 'timeout',
        error: 'Workflow execution timed out'
      })

      return {
        success: false,
        timeout: true,
        error: `Workflow timed out after ${Math.round(timeout / 1000)} seconds`
      }
    }

    // Wait before next poll
    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval))
  }

  // Shouldn't reach here, but handle it
  return {
    success: false,
    timeout: true,
    error: 'Maximum polling attempts exceeded'
  }
}

/**
 * Handle workflow callback (webhook response)
 */
export async function handleWorkflowCallback(
  executionId: string,
  result: any
): Promise<void> {
  logger.debug('[AsyncHandler] Received callback', {
    executionId,
    hasResult: !!result
  })

  const state = await getAsyncState(executionId)

  if (!state) {
    console.error('[AsyncHandler] Unknown execution ID', { executionId })
    return
  }

  // Update state with result
  await updateAsyncState(executionId, {
    status: 'completed',
    result
  })
}

/**
 * Store async workflow state in Redis
 * CRITICAL: Direct object storage (no stringify)
 */
async function storeAsyncState(
  executionId: string,
  state: AsyncWorkflowState
): Promise<void> {
  const key = `async_workflow:${executionId}`

  // ✅ CORRECT: Pass object directly to json.set
  await redis.json.set(key, '$', state)

  // Set TTL (2 hours for async workflows)
  await redis.expire(key, 7200)
}

/**
 * Get async workflow state from Redis
 * CRITICAL: No JSON.parse needed
 */
async function getAsyncState(
  executionId: string
): Promise<AsyncWorkflowState | null> {
  const key = `async_workflow:${executionId}`

  // ✅ CORRECT: json.get returns parsed object
  const state = await redis.json.get(key) as AsyncWorkflowState | null

  return state
}

/**
 * Update async workflow state
 */
async function updateAsyncState(
  executionId: string,
  updates: Partial<AsyncWorkflowState>
): Promise<void> {
  const key = `async_workflow:${executionId}`

  // Get current state
  const current = await getAsyncState(executionId)

  if (!current) {
    console.error('[AsyncHandler] Cannot update missing state', { executionId })
    return
  }

  // Merge updates
  const updated = { ...current, ...updates }

  // ✅ CORRECT: Pass object directly
  await redis.json.set(key, '$', updated)
}

/**
 * Generate unique execution ID
 */
function generateExecutionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `exec_${timestamp}_${random}`
}

/**
 * Generate callback URL for workflow
 */
function generateCallbackUrl(executionId: string): string {
  const baseUrl = env.PUBLIC_BASE_URL || 'http://localhost:5620'
  return `${baseUrl}/api/workflows/callback/${executionId}`
}

/**
 * Clean up old async states
 * Should be run periodically
 */
export async function cleanupAsyncStates(): Promise<void> {
  logger.debug('[AsyncHandler] Cleaning up old async states')

  try {
    // Find all async workflow keys
    const keys = await redis.keys('async_workflow:*')

    if (keys.length === 0) {
      return
    }

    const now = Date.now()
    let cleaned = 0

    for (const key of keys) {
      const state = await redis.json.get(key) as AsyncWorkflowState | null

      if (!state) {
        continue
      }

      // Clean up states older than 2 hours
      if (now - state.startTime > 7200000) {
        await redis.del(key)
        cleaned++
      }
    }

    logger.debug('[AsyncHandler] Cleaned async states', { cleaned })
  } catch (error) {
    console.error('[AsyncHandler] Cleanup error:', error)
  }
}

/**
 * Get all active async executions
 * Useful for monitoring and debugging
 */
export async function getActiveExecutions(): Promise<AsyncWorkflowState[]> {
  try {
    const keys = await redis.keys('async_workflow:*')
    const states: AsyncWorkflowState[] = []

    for (const key of keys) {
      const state = await redis.json.get(key) as AsyncWorkflowState | null

      if (state && (state.status === 'pending' || state.status === 'running')) {
        states.push(state)
      }
    }

    return states
  } catch (error) {
    console.error('[AsyncHandler] Error getting active executions:', error)
    return []
  }
}
