const {
  tokenEquals,
  hasValidServiceToken,
  requireServiceToken,
} = require('../serviceTokenAuth');

function mockReq(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return { get: (name) => normalized[name.toLowerCase()] };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('serviceTokenAuth', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env.BATSHIT_TOKEN = ORIGINAL_ENV.BATSHIT_TOKEN;
    process.env.MCP_GATEWAY_AUTH_TOKEN = ORIGINAL_ENV.MCP_GATEWAY_AUTH_TOKEN;
    if (ORIGINAL_ENV.BATSHIT_TOKEN === undefined) delete process.env.BATSHIT_TOKEN;
    if (ORIGINAL_ENV.MCP_GATEWAY_AUTH_TOKEN === undefined) delete process.env.MCP_GATEWAY_AUTH_TOKEN;
  });

  describe('tokenEquals', () => {
    it('rejects empty/missing values', () => {
      expect(tokenEquals('', 'secret')).toBe(false);
      expect(tokenEquals('secret', '')).toBe(false);
      expect(tokenEquals(undefined, 'secret')).toBe(false);
      expect(tokenEquals('secret', undefined)).toBe(false);
    });

    it('rejects length mismatches without throwing', () => {
      expect(tokenEquals('short', 'a-much-longer-token')).toBe(false);
    });

    it('accepts exact matches and rejects same-length mismatches', () => {
      expect(tokenEquals('token-abc-123', 'token-abc-123')).toBe(true);
      expect(tokenEquals('token-abc-123', 'token-abc-124')).toBe(false);
    });
  });

  describe('requireServiceToken', () => {
    it('fails closed with 503 when no token is configured', () => {
      delete process.env.BATSHIT_TOKEN;
      delete process.env.MCP_GATEWAY_AUTH_TOKEN;
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(mockReq(), res, () => { nextCalled = true; });
      expect(res.statusCode).toBe(503);
      expect(nextCalled).toBe(false);
    });

    it('rejects requests without a token header', () => {
      process.env.BATSHIT_TOKEN = 'configured-token-value';
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(mockReq(), res, () => { nextCalled = true; });
      expect(res.statusCode).toBe(401);
      expect(nextCalled).toBe(false);
    });

    it('rejects requests with a wrong token', () => {
      process.env.BATSHIT_TOKEN = 'configured-token-value';
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(
        mockReq({ 'x-batshit-service-token': 'wrong-token-value-00' }),
        res,
        () => { nextCalled = true; }
      );
      expect(res.statusCode).toBe(401);
      expect(nextCalled).toBe(false);
    });

    it('accepts the configured token on x-batshit-service-token', () => {
      process.env.BATSHIT_TOKEN = 'configured-token-value';
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(
        mockReq({ 'x-batshit-service-token': 'configured-token-value' }),
        res,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeNull();
    });

    it('accepts the configured token on the legacy x-batshit-token header', () => {
      process.env.BATSHIT_TOKEN = 'configured-token-value';
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(
        mockReq({ 'x-batshit-token': 'configured-token-value' }),
        res,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
    });

    it('falls back to MCP_GATEWAY_AUTH_TOKEN when BATSHIT_TOKEN is unset', () => {
      delete process.env.BATSHIT_TOKEN;
      process.env.MCP_GATEWAY_AUTH_TOKEN = 'gateway-token-value';
      const res = mockRes();
      let nextCalled = false;
      requireServiceToken(
        mockReq({ 'x-batshit-service-token': 'gateway-token-value' }),
        res,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
    });
  });

  describe('hasValidServiceToken', () => {
    it('is false when nothing is configured (never allow-by-default)', () => {
      delete process.env.BATSHIT_TOKEN;
      delete process.env.MCP_GATEWAY_AUTH_TOKEN;
      expect(hasValidServiceToken(mockReq({ 'x-batshit-service-token': '' }))).toBe(false);
      expect(hasValidServiceToken(mockReq())).toBe(false);
    });
  });
});
