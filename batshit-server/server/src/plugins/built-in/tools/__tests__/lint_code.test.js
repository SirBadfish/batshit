const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { lintCode } = require('../lint_code');

describe('lint_code ESLint 10 migration', () => {
  const tempDirs = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the embedded JavaScript flat config and applies formatting fixes', async () => {
    const result = await lintCode('console.log("batshit")\n', 'javascript', null, null, false, true);

    expect(result.isSuccess).toBe(true);
    expect(result.linterUsed).toBe('eslint');
    expect(result.fixedCodeContent).toContain("console.log('batshit');");
    expect(result.fixesAppliedCount).toBeGreaterThan(0);
  });

  it('uses the embedded TypeScript flat config and keeps TypeScript parsing working', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-eslint-fallback-'));
    tempDirs.push(projectRoot);

    const result = await lintCode(
      'const value: number = 1\nconsole.log(value)\n',
      'typescript',
      'src/example.ts',
      projectRoot,
      true,
      true
    );

    expect(result.isSuccess).toBe(true);
    expect(result.linterUsed).toBe('eslint');
    expect(result.fixedCodeContent).toContain('const value: number = 1;');
    expect(result.fixedCodeContent).toContain('console.log(value);');
  });

  it('fails loudly when a project still uses legacy eslintrc config', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-eslint-legacy-'));
    tempDirs.push(projectRoot);
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.eslintrc.json'),
      JSON.stringify({ rules: { semi: ['error', 'never'] } }, null, 2)
    );

    const result = await lintCode(
      'const value = 1;',
      'javascript',
      'src/example.js',
      projectRoot,
      true,
      false
    );

    expect(result.isSuccess).toBe(false);
    expect(result.linterInternalError).toMatch(/eslint\.config/i);
    expect(result.linterInternalError).toMatch(/ESLint 10/i);
  });
});
