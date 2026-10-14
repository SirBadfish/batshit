const { resolveBatshitAppUrl } = require('../batshitAppUrl');

// BL-562: batshit-server's one answer to "where is the app": the configured address, or an error.
describe('resolveBatshitAppUrl', () => {
  test('returns BATSHIT_FRONTEND_URL without a trailing slash', () => {
    expect(resolveBatshitAppUrl({ BATSHIT_FRONTEND_URL: 'http://127.0.0.1:5621' })).toBe('http://127.0.0.1:5621');
    expect(resolveBatshitAppUrl({ BATSHIT_FRONTEND_URL: ' http://app:3000// ' })).toBe('http://app:3000');
  });

  test('refuses, naming the variable, when it is unset or blank; never the Mac app by default', () => {
    for (const env of [{}, { BATSHIT_FRONTEND_URL: '' }, { BATSHIT_FRONTEND_URL: '   ' }]) {
      expect(() => resolveBatshitAppUrl(env)).toThrow(/BATSHIT_FRONTEND_URL is not set/);
    }
  });
});
