// Batshit's Pinokio menu. Reference example: examples/mochi/pinokio.js (the info.* menu).
const os = require("os")
const path = require("path")
const { windowsMenuState } = require('./lib/windows-wsl-steps.cjs')

// Your Batshit data: chats, agents, uploads, saved API keys. Kept outside this folder, so Reset
// and Update never touch it.
const dataFolder = path.join(os.homedir(), ".batshit", "pinokio")

module.exports = {
  version: "8.0.0",
  title: "Batshit",
  description: "An alpha self-hosted AI workspace: API and CLI agents, tools, artifacts, voice, and local AI in one place.",
  icon: "icon.png",
  menu: async (kernel, info) => {
    // Host file/registry status only; opening the menu must not boot a stopped Linux guest.
    const windows = process.platform === 'win32'
    const wslState = windows ? await windowsMenuState() : null
    const installed = windows ? wslState.installed : info.exists("runtime/installed.json")
    const running = {
      install: info.running("install.js"),
      start: info.running("start.js"),
      update: info.running("update.js"),
      reset: info.running("reset.js"),
      deleteData: info.running("delete-data.js")
    }
    if (running.install) {
      return [{ default: true, icon: "fa-solid fa-plug", text: "Installing", href: "install.js" }]
    }
    if (running.update) {
      return [{ default: true, icon: "fa-solid fa-rotate", text: "Updating", href: "update.js" }]
    }
    if (running.reset) {
      return [{ default: true, icon: "fa-solid fa-broom", text: "Resetting", href: "reset.js" }]
    }
    if (running.deleteData) {
      return [{ default: true, icon: "fa-solid fa-trash", text: "Deleting data", href: "delete-data.js" }]
    }
    const deleteData = (windows ? wslState.dataPresent : info.exists(dataFolder))
      ? [{ icon: "fa-solid fa-trash", text: "Delete Batshit data", href: "delete-data.js" }]
      : []
    if (!installed) {
      // An owned interrupted first install must still discover a repaired RELEASE.
      // Fresh/unsupported setup keeps the original Install prerequisite route.
      const recoveryUpdate = windows && wslState.retained
        ? [{ icon: "fa-solid fa-rotate", text: "Update", href: "update.js" }]
        : []
      return [{ default: true, icon: "fa-solid fa-plug", text: "Install", href: "install.js" }, ...recoveryUpdate, ...deleteData]
    }
    if (running.start) {
      const local = info.local("start.js")
      if (info.ready("start.js") && local && local.url) {
        // Batshit opens in the browser: it does not allow itself inside another page's frame.
        return [{
          default: true,
          icon: "fa-solid fa-rocket",
          text: "Open Batshit",
          href: local.url,
          popout: true
        }, {
          icon: "fa-solid fa-terminal",
          text: "Terminal",
          href: "start.js"
        }]
      }
      return [{ default: true, icon: "fa-solid fa-terminal", text: "Terminal", href: "start.js" }]
    }
    return [
      { default: true, icon: "fa-solid fa-power-off", text: "Start", href: "start.js" },
      { icon: "fa-solid fa-rotate", text: "Update", href: "update.js" },
      { icon: "fa-solid fa-plug", text: "Install", href: "install.js" },
      { icon: "fa-solid fa-broom", text: "Reset", href: "reset.js" },
      ...deleteData
    ]
  }
}
