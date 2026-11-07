import { mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REAL_BRIDGE = path.resolve(__dirname, '../../../../../../../scripts/claude-plan-bridge.cjs')

/**
 * A scripts folder whose `claude-plan-bridge.cjs` records each hook input and every MCP line into
 * `target` (one JSON object per line), then runs the real bridge unchanged. Used by the live proof
 * to record the D13 fixtures and by the contract test to check the test double's hook and MCP traffic.
 */
export function writeRecordingBridge(parent: string, target: string): string {
  const dir = mkdtempSync(path.join(parent, 'scripts-'))
  writeFileSync(path.join(dir, 'claude-plan-bridge.cjs'), `'use strict'
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const [role, runDir] = process.argv.slice(2)
const out = ${JSON.stringify(target)}
const note = (entry) => fs.appendFileSync(out, JSON.stringify({ at: Date.now(), role, ...entry }) + '\\n')
const real = ${JSON.stringify(REAL_BRIDGE)}
if (role !== 'mcp') {
  const input = fs.readFileSync(0, 'utf8')
  note({ direction: 'hook-in', body: JSON.parse(input) })
  const result = spawnSync(process.execPath, [real, role, runDir], { input, encoding: 'utf8' })
  note({ direction: 'hook-out', code: result.status, stdout: result.stdout, stderr: result.stderr })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  process.exit(result.status ?? 1)
}
const child = spawn(process.execPath, [real, role, runDir], { stdio: ['pipe', 'pipe', 'inherit'] })
let inBuf = '', outBuf = ''
process.stdin.on('data', d => { inBuf += d; let i; while ((i = inBuf.indexOf('\\n')) >= 0) { note({ direction: 'mcp-in', body: JSON.parse(inBuf.slice(0, i)) }); inBuf = inBuf.slice(i + 1) } child.stdin.write(d) })
process.stdin.on('end', () => child.stdin.end())
child.stdout.on('data', d => { outBuf += d; let i; while ((i = outBuf.indexOf('\\n')) >= 0) { note({ direction: 'mcp-out', body: JSON.parse(outBuf.slice(0, i)) }); outBuf = outBuf.slice(i + 1) } process.stdout.write(d) })
child.on('exit', code => process.exit(code ?? 0))
`)
  return dir
}
