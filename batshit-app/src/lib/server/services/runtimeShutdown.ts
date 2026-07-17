type RuntimeShutdownTask = (reason: string) => void | Promise<void>

const shutdownTasks = new Map<string, RuntimeShutdownTask>()

export function registerRuntimeShutdownTask(name: string, task: RuntimeShutdownTask) {
  if (!name.trim()) throw new Error('Runtime shutdown task name is required.')
  shutdownTasks.set(name, task)
  return () => shutdownTasks.delete(name)
}

export async function closeRegisteredRuntimeResources(reason: string): Promise<void> {
  const pending = Array.from(shutdownTasks.entries()).map(async ([name, task]) => {
    try {
      await task(reason)
    } catch (error) {
      throw new Error(`Runtime shutdown task "${name}" failed.`, { cause: error })
    }
  })
  const results = await Promise.allSettled(pending)
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, `Runtime shutdown failed during ${reason}.`)
  }
}

export function resetRuntimeShutdownTasksForTests() {
  shutdownTasks.clear()
}
