const { sanitizeLogValue, writeErrorLog } = require('../logSafety');

describe('logSafety', () => {
  test('removes line separators and caps untrusted values', () => {
    const unsafe = `first\r\nsecond\u2028third\u2029${'x'.repeat(9000)}`;
    const sanitized = sanitizeLogValue(unsafe);

    expect(sanitized).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(sanitized).toHaveLength(8192);
  });

  test('formats errors as one safe log entry', () => {
    const logger = { error: jest.fn() };
    const error = new Error('upload failed\r\nforged entry');

    writeErrorLog(logger, 'Upload request', error);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('Upload request: Error: upload failed forged entry');
    expect(logger.error.mock.calls[0][0]).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  test('handles values that cannot be serialized', () => {
    const circular = {};
    circular.self = circular;

    expect(sanitizeLogValue(circular)).toBe('[object Object]');
  });
});
