// Loaded only by the Windows operator integration tests. It lets the real HTTP
// launch/stop path observe a delayed, ambiguous, or failed CIM table read.
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')

const root = process.env.BATSHIT_TEST_WINDOWS_TABLE_HOOK_ROOT
const armedPath = path.join(root, 'table-hook-armed')
const markerPath = path.join(root, 'table-hook-called')
const originalExecFile = childProcess.execFile

childProcess.execFile = function hookedExecFile(file, args, options, callback) {
  const isTableRead = path.basename(file).toLowerCase() === 'powershell.exe' &&
    args.some((arg) => String(arg).includes('Get-CimInstance Win32_Process'))
  if (!isTableRead || !fs.existsSync(armedPath) || fs.existsSync(markerPath)) {
    return originalExecFile(file, args, options, callback)
  }

  const mode = fs.readFileSync(armedPath, 'utf8').trim()
  fs.writeFileSync(markerPath, String(Date.now()), { flag: 'wx' })
  if (mode === 'fail') {
    process.nextTick(() => callback(new Error('test CIM read failure'), '', ''))
    return null
  }

  return originalExecFile(file, args, options, (error, stdout, stderr) => {
    if (error || mode !== 'ambiguous') {
      setTimeout(() => callback(error, stdout, stderr), mode === 'delay' ? 400 : 0)
      return
    }
    try {
      const parsed = JSON.parse(String(stdout))
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      const rootRow = rows.find((row) => String(row.CommandLine ?? '').includes('engine.mjs') &&
        String(row.CommandLine).includes('--parent'))
      if (!rootRow) throw new Error('test operator root was absent from CIM output')
      const legacy = /^\/Date\((\d+)/.exec(String(rootRow.CreationDate))
      const bornAt = legacy ? Number(legacy[1]) : Date.parse(String(rootRow.CreationDate))
      if (!Number.isFinite(bornAt)) throw new Error('test operator root had no creation time')
      rows.push({
        ProcessId: 2_147_000_000,
        ParentProcessId: rootRow.ProcessId,
        CreationDate: new Date(bornAt - 1000).toISOString(),
        CommandLine: 'ambiguous test child'
      })
      fs.writeFileSync(path.join(root, 'table-hook-injected'), String(rootRow.ProcessId))
      callback(null, JSON.stringify(rows), stderr)
    } catch (hookError) {
      callback(hookError, '', stderr)
    }
  })
}

syncBuiltinESMExports()
