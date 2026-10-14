const { createSerialTransactionQueue } = require('../serialTransactionQueue');

test('keeps rollback ahead of a successor and releases after rejection', async () => {
  const queue = createSerialTransactionQueue();
  const events = [];
  let failFirst;
  const failureGate = new Promise((resolve) => { failFirst = resolve; });

  const first = queue.run(async () => {
    events.push('write first');
    await failureGate;
    events.push('rollback first');
    throw new Error('first write failed');
  });
  const second = queue.run(async () => {
    events.push('write second');
    return 'second saved';
  });

  expect(queue.isIdle).toBe(false);
  expect(events).toEqual(['write first']);
  failFirst();
  await expect(first).rejects.toThrow('first write failed');
  await expect(second).resolves.toBe('second saved');
  expect(events).toEqual(['write first', 'rollback first', 'write second']);
  expect(queue.isIdle).toBe(true);

  await expect(queue.run(async () => 'next batch')).resolves.toBe('next batch');
  expect(queue.isIdle).toBe(true);
});
