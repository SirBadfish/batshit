export async function settleShutdownPreparations(
  preparations,
  {
    timeoutMs = 5_000,
    onFailure = (name, error) => console.error(`[Batshit Mac] ${name} shutdown preparation failed:`, error)
  } = {}
) {
  if (!Array.isArray(preparations) || preparations.some((entry) => (
    !entry || typeof entry.name !== 'string' || typeof entry.run !== 'function'
  ))) {
    throw new Error('Shutdown preparations must be named functions.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('Shutdown preparation timeout must be between 1 and 60000 milliseconds.');
  }

  const bounded = preparations.map(({ name, run }) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} shutdown preparation timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
    timer.unref?.();
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  }));
  const results = await Promise.allSettled(bounded);
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      onFailure(preparations[index].name, result.reason);
    }
  });
  return results;
}
