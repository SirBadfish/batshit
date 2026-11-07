jest.mock('../redisService', () => ({}));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const BuiltInService = require('../builtInService');

const poetry = `
[tool.poetry]
name = "owned-project"
version = "1.2.3"
[tool.poetry.dependencies]
python = "^3.12"
requests = { version = "^2.32", extras = ["socks"] }
[tool.poetry.dev-dependencies]
pytest = "^8.0"
`;

describe('Poetry dependency analysis with the actual TOML parser', () => {
  let root;
  const service = new BuiltInService();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-poetry-dependencies-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function analyze(content, packageManager = 'poetry') {
    const file = path.join(root, 'pyproject.toml');
    await fs.writeFile(file, content);
    const result = await service.analyzeDependencies(root, { packageManager });
    expect(await fs.readFile(file, 'utf8')).toBe(content);
    return result;
  }

  function expectOrdinaryAnalysis(result) {
    expect(result).toEqual({
      success: true,
      tool: 'analyze_dependencies',
      results: {
        packageManager: 'poetry',
        name: 'owned-project',
        version: '1.2.3',
        dependencies: { python: '^3.12', requests: { version: '^2.32', extras: ['socks'] } },
        devDependencies: { pytest: '^8.0' },
        totalDependencies: 2,
        totalDevDependencies: 1
      }
    });
  }

  it('auto-detects ordinary Poetry dependencies without changing the source file', async () => {
    expectOrdinaryAnalysis(await analyze(poetry, 'auto'));
  });

  it('preserves exact safe Number values and quoted version strings', async () => {
    const content = 'safe = 9007199254740991\nnegative = -9007199254740991\nhex = 0xff\n' + poetry;
    expect(toml.parse(content)).toMatchObject({ safe: Number.MAX_SAFE_INTEGER, negative: -Number.MAX_SAFE_INTEGER, hex: 255 });
    expectOrdinaryAnalysis(await analyze(content));
  });

  it.each(['9007199254740993', '-9007199254740993', '9223372036854775807', '-9223372036854775808'])(
    'reports unsafe default Number input %s without rounding or writing', async literal => {
      const result = await analyze(`unrelated = ${literal}\n` + poetry);
      expect(result).toMatchObject({ success: false, tool: 'analyze_dependencies' });
      expect(result.error).toMatch(/cannot be represented losslessly as a JavaScript number/);
      expect(result.results).toBeUndefined();
    }
  );

  // Small shapes from the CPU advisories exercise the repaired paths without a timing benchmark.
  it('keeps distinct and repeated arrays of tables compatible', async () => {
    const distinct = Array.from({ length: 16 }, (_, index) => `[[a${index}]]\nv = ${index}\n`).join('');
    const repeated = Array.from({ length: 4 }, (_, index) => `[[repeated]]\nv = ${index}\n`).join('');
    const content = distinct + repeated + poetry;
    const parsed = toml.parse(content);
    expect(parsed.a15).toEqual([{ v: 15 }]);
    expect(parsed.repeated).toEqual([{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }]);
    expectOrdinaryAnalysis(await analyze(content));
  });

  const keys = Array.from({ length: 32 }, (_, index) => `k${index}`);
  const dotted = keys.join('.');
  it.each([
    ['assignment', `${dotted} = 1\n`, false, false],
    ['table', `[${dotted}]\nv = 1\n`, false, true],
    ['array table', `[[${dotted}]]\nv = 1\n`, true, true],
    ['inline table', `t = { ${dotted} = 1 }\n`, false, false]
  ])('keeps a bounded long dotted %s compatible', async (kind, prefix, array, table) => {
    const parsed = toml.parse(prefix);
    let leaf = kind === 'inline table' ? parsed.t : parsed;
    for (const key of keys) leaf = leaf[key];
    expect(leaf).toEqual(array ? [{ v: 1 }] : table ? { v: 1 } : 1);
    expectOrdinaryAnalysis(await analyze(prefix + poetry));
  });

  it.each(['9'.repeat(20), '0x' + 'f'.repeat(17), '0o' + '7'.repeat(22), '0b' + '1'.repeat(64)])(
    'refuses a literal beyond its significant-digit bound: %s', async literal => {
      const result = await analyze(`unrelated = ${literal}\n` + poetry);
      expect(result).toMatchObject({ success: false, tool: 'analyze_dependencies' });
      expect(result.error).toMatch(/outside the 64-bit signed integer range/);
      expect(result.results).toBeUndefined();
    }
  );

  it('refuses the prototype advisory prefix before any prototype-write statement', async () => {
    const prefix = `"b.c" = 1979-05-27T07:32:00Z\n[['"b']]\n["b.c"]\n`;
    const result = await analyze(prefix + poetry);
    expect(result).toMatchObject({ success: false, tool: 'analyze_dependencies' });
    expect(result.error).toMatch(/Cannot redefine existing key/);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('reports malformed TOML as a failed analysis without changing its bytes', async () => {
    const result = await analyze('[tool.poetry\nname = "invalid"\n');
    expect(result).toMatchObject({ success: false, tool: 'analyze_dependencies' });
    expect(result.error).toEqual(expect.any(String));
    expect(result.error.length).toBeGreaterThan(0);
  });
});
