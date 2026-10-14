// Deletes what Install downloaded and built, so the next Install starts clean. Your Batshit data
// (chats, agents, uploads, saved API keys) lives in ~/.batshit/pinokio and is not touched.
const { windowsActionSteps } = require('./lib/windows-wsl-steps.cjs');
module.exports = {
  run: process.platform === 'win32' ? () => windowsActionSteps('reset') : [
    {
      method: "fs.rm",
      params: {
        path: "runtime"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "../batshit-app/node_modules"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "../batshit-app/build"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "../batshit-app/.svelte-kit"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "../batshit-server/server/node_modules"
      }
    }
  ]
}
