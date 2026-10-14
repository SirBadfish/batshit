// Starts Batshit's three processes in order, each waiting for the one before it: Redis, the
// file server (batshit-server), then the app. Reference examples: examples/autogpt/start.js
// (a backend before the web UI) and the URL capture of examples/mochi/start.js.
const { windowsActionSteps } = require('./lib/windows-wsl-steps.cjs');
module.exports = {
  daemon: true,
  run: process.platform === 'win32' ? () => windowsActionSteps('start') : [
    {
      // Batshit's fixed ports must be free; a taken port is an error, never a different port.
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs preflight"
      }
    },
    {
      // Not Redis's own "Ready to accept connections": Pinokio matches an event only in the last
      // 300 characters it read, and Redis prints more than that right after it (BL-363). Redis
      // logs to a file instead, and `run redis` prints this one line, last, once Redis answers.
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs run redis",
        on: [{
          event: "/Batshit: the database is ready\\./",
          done: true
        }]
      }
    },
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs run server",
        on: [{
          event: "/HTTP server running at/",
          done: true
        }]
      }
    },
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs run app",
        on: [{
          event: "/(http:\\/\\/[0-9.:]+)/",
          done: true
        }]
      }
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[1]}}"
      }
    },
    {
      method: "process.wait",
      params: {
        url: "{{local.url}}/api/health",
        message: "Waiting for Batshit to answer...",
        title: "Starting Batshit",
        description: "Pinokio continues when Batshit answers"
      }
    }
  ]
}
