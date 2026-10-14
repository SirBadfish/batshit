// format_code is the built-in formatter: Prettier for JS and friends, Ruff (WASM) for Python.
// Both load through a dynamic import(), which Jest's module sandbox refuses, so each case runs
// the real service in a plain Node child, the way the server runs it. Removing either package
// or breaking the Ruff start-up fails here (the lint_code retirement, 2026-10-13, kept both).
const { spawnSync } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const SERVICE = path.resolve(__dirname, '../builtInService.js');
const MARK = '__FORMAT_RESULT__';
const CHILD = `
const BuiltInService = require(process.argv[1]);
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', async () => {
  const { projectPath, params } = JSON.parse(input);
  const result = await new BuiltInService().formatCode(projectPath, params);
  process.stdout.write('\\n${MARK}' + JSON.stringify(result) + '\\n');
  process.exit(0);
});
`;

function formatInNode(projectPath, params) {
  const child = spawnSync(process.execPath, ['-e', CHILD, SERVICE], {
    input: JSON.stringify({ projectPath, params }),
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
    timeout: 30_000,
  });
  const line = child.stdout.split('\n').find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`formatCode child gave no result (status ${child.status}): ${child.stderr}`);
  return JSON.parse(line.slice(MARK.length));
}

describe('BuiltInService.formatCode', () => {
  let projectPath;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-format-code-'));
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('formats JavaScript content with Prettier', () => {
    const result = formatInNode(projectPath, {
      filePath: 'sample.js',
      content: 'const  a={b:1,c:[1,2]}\nfunction f( x ){return x*2}\n',
    });

    expect(result).toMatchObject({ success: true, formatter: 'prettier', changed: true });
    expect(result.formattedCode).toBe('const a = { b: 1, c: [1, 2] };\nfunction f(x) {\n  return x * 2;\n}\n');
  });

  it('formats Python content with Ruff', () => {
    const result = formatInNode(projectPath, {
      filePath: 'sample.py',
      content: "def f( x ):\n  return {'a':x}\n",
    });

    expect(result).toMatchObject({ success: true, formatter: 'ruff', changed: true });
    expect(result.formattedCode).toBe('def f(x):\n    return {"a": x}\n');
  });

  it('formats a Python file in place when only its path is given', async () => {
    const file = path.join(projectPath, 'module.py');
    await fs.writeFile(file, 'x=[1,2 ,3]\n');

    const result = formatInNode(projectPath, { filePath: 'module.py' });

    expect(result).toMatchObject({ success: true, formatter: 'ruff' });
    expect(await fs.readFile(file, 'utf8')).toBe('x = [1, 2, 3]\n');
  });
});
