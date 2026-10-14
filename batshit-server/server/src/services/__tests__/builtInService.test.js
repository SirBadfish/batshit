jest.mock('glob', () => ({
  glob: jest.fn()
}));

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { glob } = require('glob');
const BuiltInService = require('../builtInService');

describe('BuiltInService product repo protection', () => {
  const service = new BuiltInService();
  const repoRoot = path.resolve(__dirname, '../../../../../');

  it('blocks writeFile inside the Batshit repo', async () => {
    const result = await service.writeFile(repoRoot, {
      filePath: 'docs/__blocked_built_in_service_test__.md',
      content: 'nope'
    });

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toMatch(/product source is read-only/i);
  });

  it('blocks executeCommand mutations inside the Batshit repo', async () => {
    const result = await service.executeCommand(repoRoot, {
      command: "cat > docs/__blocked_built_in_service_test__.md <<'EOF'\nnope\nEOF"
    });

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toMatch(/product source is read-only/i);
  });

  // glob is called with withFileTypes: true, so mocks return Path-like entries.
  function fakeWalkEntry(relativePath, { directory = false } = {}) {
    return {
      name: path.basename(relativePath),
      relative: () => relativePath,
      isDirectory: () => directory
    };
  }

  it('includes directory entries even when glob results are not mark-suffixed', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-dir-'));
    await fs.mkdir(path.join(tempRoot, 'src'));
    glob.mockResolvedValueOnce([fakeWalkEntry('src', { directory: true })]);

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        includeDirs: true,
        maxDepth: 1
      });

      expect(glob).toHaveBeenCalledWith(
        '*',
        expect.objectContaining({ withFileTypes: true })
      );
      expect(result.success).toBe(true);
      expect(result.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'src',
            path: 'src',
            type: 'directory',
            size: expect.any(Number),
            mtime: expect.any(String)
          })
        ])
      );
      expect(result.truncated).toBeUndefined();
      expect(result.totalBeforeTruncation).toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips entries that disappear after glob finds them', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-missing-'));
    glob.mockResolvedValueOnce([fakeWalkEntry('SingletonLock')]);
    const statsSpy = jest
      .spyOn(service, '_getListablePathStats')
      .mockResolvedValueOnce(null);

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        includeDirs: true,
        maxDepth: 1
      });

      expect(result.success).toBe(true);
      expect(result.files).toEqual([]);
      expect(statsSpy).toHaveBeenCalledWith(path.join(tempRoot, 'SingletonLock'));
    } finally {
      statsSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('lite mode returns name/path/type from the walk without any stat calls', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-lite-'));
    glob.mockResolvedValueOnce([
      fakeWalkEntry('src', { directory: true }),
      fakeWalkEntry('src/index.js'),
      fakeWalkEntry('README.md')
    ]);
    const statsSpy = jest.spyOn(service, '_getListablePathStats');

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        recursive: true,
        includeDirs: true,
        lite: true
      });

      expect(result.success).toBe(true);
      expect(statsSpy).not.toHaveBeenCalled();
      expect(result.files).toEqual([
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'index.js', path: path.join('src', 'index.js'), type: 'file' },
        { name: 'README.md', path: 'README.md', type: 'file' }
      ]);
      expect(result.totalFiles).toBe(2);
      expect(result.totalDirectories).toBe(1);
    } finally {
      statsSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('lite mode still honors includeDirs: false', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-lite-dirs-'));
    glob.mockResolvedValueOnce([
      fakeWalkEntry('src', { directory: true }),
      fakeWalkEntry('src/index.js')
    ]);

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        recursive: true,
        includeDirs: false,
        lite: true
      });

      expect(result.success).toBe(true);
      expect(result.files).toEqual([
        { name: 'index.js', path: path.join('src', 'index.js'), type: 'file' }
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('truncates walk results beyond maxEntries and reports the original total', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-truncate-'));
    glob.mockResolvedValueOnce([
      fakeWalkEntry('a.txt'),
      fakeWalkEntry('b.txt'),
      fakeWalkEntry('c.txt'),
      fakeWalkEntry('d.txt'),
      fakeWalkEntry('e.txt')
    ]);

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        includeDirs: true,
        lite: true,
        maxEntries: 2
      });

      expect(result.success).toBe(true);
      expect(result.files).toEqual([
        { name: 'a.txt', path: 'a.txt', type: 'file' },
        { name: 'b.txt', path: 'b.txt', type: 'file' }
      ]);
      expect(result.truncated).toBe(true);
      expect(result.totalBeforeTruncation).toBe(5);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps size/mtime in non-lite mode using bounded-concurrency stats', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-list-files-stat-'));
    await fs.writeFile(path.join(tempRoot, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(tempRoot, 'b.txt'), 'bravo!');
    glob.mockResolvedValueOnce([fakeWalkEntry('a.txt'), fakeWalkEntry('b.txt')]);

    try {
      const result = await service.listFiles(tempRoot, {
        pattern: '*',
        includeDirs: false,
        maxDepth: 1
      });

      expect(result.success).toBe(true);
      expect(result.files).toEqual([
        expect.objectContaining({ name: 'a.txt', type: 'file', size: 5, mtime: expect.any(String) }),
        expect.objectContaining({ name: 'b.txt', type: 'file', size: 6, mtime: expect.any(String) })
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes legacy exclusion patterns to recursive forms', () => {
    expect(
      service._getEffectiveExcludePattern({
        useDefaultExclusions: false,
        customExcludePattern: 'node_modules/**,dist/**,*.log,.env,.env.*,.git/**'
      })
    ).toBe('**/node_modules/**,**/dist/**,**/*.log,**/.env,**/.env.*,**/.git/**');
  });
});

describe('BuiltInService validatePathWithinProject (BL-728)', () => {
  const service = new BuiltInService();
  const projectPath = '/tmp/project';

  it('allows the project root itself', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project')).not.toThrow();
  });

  it('allows a child path', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project/file.txt')).not.toThrow();
  });

  it('allows a deep child path', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project/a/b/c/file.txt')).not.toThrow();
  });

  it('rejects a sibling directory that only shares a name prefix', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project-other')).toThrow(
      /Path traversal attempt detected/
    );
  });

  it('rejects a file inside a sibling directory that only shares a name prefix', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project-other/file.txt')).toThrow(
      /Path traversal attempt detected/
    );
  });

  it('rejects another sibling with a numeric suffix prefix collision', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project2')).toThrow(
      /Path traversal attempt detected/
    );
  });

  it('rejects .. traversal that escapes the project', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project/../project-other/file.txt')).toThrow(
      /Path traversal attempt detected/
    );
  });

  it('allows a project path with a trailing slash', () => {
    expect(() => service.validatePathWithinProject('/tmp/project/', '/tmp/project/file.txt')).not.toThrow();
  });

  it('allows a child folder whose name starts with two dots', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project/..cache')).not.toThrow();
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project/..cache/file.txt')).not.toThrow();
  });

  it('keeps the exact error message text', () => {
    expect(() => service.validatePathWithinProject(projectPath, '/tmp/project-other')).toThrow(
      'Path traversal attempt detected. Path /tmp/project-other is outside of project root.'
    );
  });
});

describe('BuiltInService._isPathWithinRoot (BL-728 sweep)', () => {
  const service = new BuiltInService();
  const root = '/tmp/root';

  it('treats the root itself as within the root', () => {
    expect(service._isPathWithinRoot(root, '/tmp/root')).toBe(true);
  });

  it('treats a child as within the root', () => {
    expect(service._isPathWithinRoot(root, '/tmp/root/child')).toBe(true);
  });

  it('treats a child folder whose name starts with two dots as within the root', () => {
    expect(service._isPathWithinRoot(root, '/tmp/root/..cache')).toBe(true);
    expect(service._isPathWithinRoot(root, '/tmp/root/..cache/file.txt')).toBe(true);
  });

  it('treats a sibling with the same prefix as outside the root', () => {
    expect(service._isPathWithinRoot(root, '/tmp/root-other')).toBe(false);
  });

  it('treats .. traversal as outside the root', () => {
    expect(service._isPathWithinRoot(root, '/tmp/root/../root-other')).toBe(false);
  });
});
