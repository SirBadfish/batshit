/**
 * BL-282 (2026-09-27): the upload strategy has no delete.
 *
 * `LocalStorageStrategy#delete()` read the record through `redisService.get`, which answers
 * null on a Redis error, then deleted the key and kept the file with nothing pointing at it:
 * BL-144's bug, which the upload routes fixed with a read that throws
 * (`readUploadRecordForDelete` in `upload-redis.js`). Nothing ever called it (the upload
 * manager exposes only `upload` and `testConnection`), so it was removed with the base
 * class's placeholder rather than repaired. Every upload delete goes through
 * `deleteStoredUploadRecord`; a strategy delete must not come back beside it.
 */

jest.mock('../redisService', () => ({}));

const BaseUploadStrategy = require('../uploadStrategies/baseStrategy');
const LocalStorageStrategy = require('../uploadStrategies/localStrategy');
const uploadManager = require('../uploadManager');

describe('upload strategies (BL-282)', () => {
  it('the local strategy and its base offer no delete', () => {
    expect(new LocalStorageStrategy().delete).toBeUndefined();
    expect(new BaseUploadStrategy().delete).toBeUndefined();
  });

  it('the upload manager offers no delete either', () => {
    expect(uploadManager.delete).toBeUndefined();
    uploadManager.setStrategy('local');
    expect(uploadManager.currentStrategy.delete).toBeUndefined();
  });
});
