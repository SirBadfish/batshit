// Deletes all of your Batshit data (~/.batshit/pinokio): chats, agents, uploads, saved API keys,
// and the secrets that unlock them. It asks first. Batshit must be stopped.
const { windowsActionSteps } = require('./lib/windows-wsl-steps.cjs');
module.exports = {
  run: process.platform === 'win32' ? () => windowsActionSteps('delete-data') : [
    {
      method: "input",
      params: {
        title: "Delete all Batshit data?",
        description: "This deletes your chats, agents, uploads, and saved API keys in ~/.batshit/pinokio. It cannot be undone. Make a backup first in Batshit: Settings → Admin → Backup.",
        form: [{
          key: "confirm",
          title: "Type DELETE to confirm"
        }]
      }
    },
    {
      method: "shell.run",
      params: {
        env: {
          BATSHIT_DELETE_CONFIRM: "{{input.confirm}}"
        },
        message: "node lib/cli.mjs delete-data"
      }
    }
  ]
}
