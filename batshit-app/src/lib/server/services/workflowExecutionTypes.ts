/**
 * Shared workflow execution types.
 *
 * Kept separate from workflowExecutor/workflowAsyncHandler so those runtime
 * services do not need to import each other for type-only contracts.
 */

export interface WorkflowExecutionOptions {
  timeout?: number
  sessionId?: string
  userId?: string
  retries?: number
  async?: boolean
  abortSignal?: AbortSignal
}

export interface WorkflowExecutionResult {
  success: boolean
  data?: any
  error?: string
  timeout?: boolean
  workflowName: string
  executionTime: number
  method?: 'webhook' | 'async'
  executionId?: string
}
