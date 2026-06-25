const redisService = require('../redisService');

describe('redisService connection config', () => {
  const { resolveRedisConnectionConfig } = redisService;

  test('defaults to the normal local Redis Stack port when no env override is set', () => {
    expect(resolveRedisConnectionConfig({})).toEqual({
      socket: {
        host: 'localhost',
        port: 6379
      },
      database: undefined
    });
  });

  test('uses REDIS_URL so dedicated runtime stacks can use a separate Redis port', () => {
    expect(
      resolveRedisConnectionConfig({
        REDIS_URL: 'redis://127.0.0.1:6380/0'
      })
    ).toEqual({
      url: 'redis://127.0.0.1:6380/0',
      database: 0
    });
  });

  test('lets REDIS_DB override the database encoded in REDIS_URL', () => {
    expect(
      resolveRedisConnectionConfig({
        REDIS_URL: 'redis://127.0.0.1:6380/0',
        REDIS_DB: '2'
      })
    ).toEqual({
      url: 'redis://127.0.0.1:6380/0',
      database: 2
    });
  });

  test('supports REDIS_HOST and REDIS_PORT when REDIS_URL is not set', () => {
    expect(
      resolveRedisConnectionConfig({
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6380',
        REDIS_DB: '3'
      })
    ).toEqual({
      socket: {
        host: '127.0.0.1',
        port: 6380
      },
      database: 3
    });
  });

  test('fails loudly for an invalid REDIS_URL', () => {
    expect(() =>
      resolveRedisConnectionConfig({
        REDIS_URL: 'not a redis url'
      })
    ).toThrow('Invalid REDIS_URL');
  });
});
