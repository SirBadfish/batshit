const path = require('node:path');

// Load the actual config owner, while keeping workstation dotenv/files and all
// startup services outside this configuration-boundary proof.
function configFixture({ env = {}, fileConfig, rawConfig } = {}) {
  const configPath = path.join(__dirname, 'synthetic-config.json');
  const contents = rawConfig ?? (fileConfig === undefined ? undefined : JSON.stringify(fileConfig));
  const fs = {
    existsSync: jest.fn((candidate) => candidate === configPath && contents !== undefined),
    readFileSync: jest.fn(() => contents),
    mkdirSync: jest.fn()
  };
  const dotenv = { config: jest.fn() };
  const load = () => {
    const previousEnv = process.env;
    let config;
    try {
      process.env = {
        CONFIG_PATH: configPath,
        UPLOADS_DIR: path.join(__dirname, 'synthetic-uploads'),
        BATSHIT_BACKUP_STAGING_DIR: path.join(__dirname, 'synthetic-staging'),
        ...env
      };
      jest.isolateModules(() => {
        jest.doMock('fs', () => fs);
        jest.doMock('dotenv', () => dotenv);
        config = require('../config');
      });
      return config;
    } finally {
      process.env = previousEnv;
    }
  };
  return { fs, dotenv, load, configPath };
}

afterEach(() => {
  jest.dontMock('fs');
  jest.dontMock('dotenv');
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('effective server listener configuration (BL-425)', () => {
  test.each([
    ['defaults', {}, false, false],
    ['plain HTTP', { ENABLE_HTTPS: 'false', HTTPS_ONLY: 'false' }, false, false],
    ['HTTP and HTTPS', { ENABLE_HTTPS: 'true', HTTPS_ONLY: 'false' }, true, false],
    ['HTTPS only', { ENABLE_HTTPS: 'true', HTTPS_ONLY: 'true' }, true, true]
  ])('admits %s without starting services or reading certificates', (_name, env, enableHttps, httpsOnly) => {
    const fixture = configFixture({ env });
    const config = fixture.load();

    expect(config).toMatchObject({ enableHttps, httpsOnly, host: '127.0.0.1', port: 5600, httpsPort: 5600 });
    expect(fixture.dotenv.config).toHaveBeenCalledTimes(1);
    expect(fixture.fs.readFileSync).not.toHaveBeenCalled();
    expect(fixture.fs.mkdirSync.mock.calls).toEqual([
      [config.uploadsDir, { recursive: true }],
      [config.backupStagingDir, { recursive: true, mode: 0o700 }]
    ]);
  });

  test.each([{}, { ENABLE_HTTPS: 'false' }])('refuses HTTPS-only with HTTPS disabled before directory creation (%j)', (env) => {
    const fixture = configFixture({ env: { ...env, HTTPS_ONLY: 'true' } });

    expect(fixture.load).toThrow(/HTTPS_ONLY.*ENABLE_HTTPS.*enable.*HTTPS.*disable.*HTTPS_ONLY/i);
    expect(fixture.fs.mkdirSync).not.toHaveBeenCalled();
    expect(fixture.fs.existsSync).toHaveBeenCalledTimes(1);
    expect(fixture.fs.existsSync).toHaveBeenCalledWith(fixture.configPath);
  });

  test.each([
    [{ ENABLE_HTTPS: 'true', HTTPS_ONLY: 'true' }, { enableHttps: false }],
    [{}, { enableHttps: false, httpsOnly: true }]
  ])('refuses an invalid merged file configuration (%j, %j)', (env, fileConfig) => {
    const fixture = configFixture({ env, fileConfig });

    expect(fixture.load).toThrow(/HTTPS_ONLY.*ENABLE_HTTPS/i);
    expect(fixture.fs.readFileSync).toHaveBeenCalledWith(fixture.configPath, 'utf8');
    expect(fixture.fs.mkdirSync).not.toHaveBeenCalled();
    expect(fixture.fs.existsSync).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ HTTPS_ONLY: 'true' }, { httpsOnly: false }, false, false],
    [{ HTTPS_ONLY: 'true' }, { enableHttps: true }, true, true],
    [{}, { enableHttps: 'false', httpsOnly: 'false' }, 'false', 'false']
  ])('preserves file overrides and existing listener truthiness (%j, %j)', (env, fileConfig, enableHttps, httpsOnly) => {
    const fixture = configFixture({ env, fileConfig: {
      host: 'synthetic-host', port: 12345, httpsPort: 12346,
      sslCertPath: 'synthetic-cert.pem', sslKeyPath: 'synthetic-key.pem', autoGenerateCerts: false,
      ...fileConfig
    } });

    expect(fixture.load()).toMatchObject({
      enableHttps, httpsOnly, host: 'synthetic-host', port: 12345, httpsPort: 12346,
      sslCertPath: 'synthetic-cert.pem', sslKeyPath: 'synthetic-key.pem', autoGenerateCerts: false
    });
    // Only config JSON is read; accepting HTTPS mode never reads/generates certificates here.
    expect(fixture.fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(fixture.fs.mkdirSync).toHaveBeenCalledTimes(2);
  });

  test.each([false, true])('retains malformed-file warning, then validates fallback settings (HTTPS-only: %s)', (httpsOnly) => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = configFixture({ rawConfig: '{', env: { HTTPS_ONLY: String(httpsOnly) } });

    if (httpsOnly) {
      expect(fixture.load).toThrow(/HTTPS_ONLY.*ENABLE_HTTPS/i);
      expect(fixture.fs.mkdirSync).not.toHaveBeenCalled();
    } else {
      expect(fixture.load()).toMatchObject({ enableHttps: false, httpsOnly: false });
      expect(fixture.fs.mkdirSync).toHaveBeenCalledTimes(2);
    }
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe(`Failed to load config from ${fixture.configPath}:`);
  });
});
