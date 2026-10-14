// Moves to the newest Batshit release (the one the repository's current launcher names) and
// reinstalls it. It never builds the main branch (SA-127 DL-02). Your data is not touched.
const { windowsActionSteps } = require('./lib/windows-wsl-steps.cjs');
module.exports = {
  run: process.platform === 'win32' ? () => windowsActionSteps('update') : [
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs update-release"
      }
    },
    {
      method: "script.start",
      params: {
        uri: "install.js"
      }
    }
  ]
}
