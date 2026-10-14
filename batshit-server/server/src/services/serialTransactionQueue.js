// Serialize a whole storage transaction, including rollback. A rejected task must
// release its successor, and an idle queue must retain no settled task chain.
function createSerialTransactionQueue() {
  let tail = null;

  return {
    run(task) {
      const previous = tail;
      let release;
      const finished = new Promise((resolve) => {
        release = resolve;
      });
      tail = finished;

      return (async () => {
        if (previous) await previous;
        try {
          return await task();
        } finally {
          if (tail === finished) tail = null;
          release();
        }
      })();
    },
    get isIdle() {
      return tail === null;
    }
  };
}

module.exports = { createSerialTransactionQueue };
