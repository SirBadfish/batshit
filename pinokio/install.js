// Installs the Batshit release named in RELEASE: its code, its packages, the built app, Redis,
// and the data folder with its two secrets. Reference example: examples/sillytavern/install.js.
const { windowsActionSteps } = require('./lib/windows-wsl-steps.cjs');
module.exports = {
  // The "dev" bundle: conda, git, Node.js, and ffmpeg (and on a Mac, Xcode's command line tools,
  // which relink Redis for this computer).
  requires: {
    bundle: "dev"
  },
  run: process.platform === 'win32' ? () => windowsActionSteps('install') : [
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs checkout-release"
      }
    },
    {
      // A release's lockfile pins every package version and hash, so the freshness delay of
      // Pinokio's package protection would only block installing a new release.
      method: "shell.run",
      params: {
        path: "../batshit-app",
        bluefairy: "off",
        message: "npm ci --no-audit --no-fund"
      }
    },
    {
      method: "shell.run",
      params: {
        path: "../batshit-server/server",
        bluefairy: "off",
        message: "npm ci --omit=dev --no-audit --no-fund"
      }
    },
    {
      method: "shell.run",
      params: {
        path: "../batshit-app",
        message: "npm run build:anchored-reader -- --if-supported"
      }
    },
    {
      method: "shell.run",
      params: {
        path: "../batshit-app",
        env: {
          BATSHIT_SVELTE_ADAPTER: "node"
        },
        message: "npm run build"
      }
    },
    {
      // Drops the build tools once the app is built, as the Docker image does. --no-save: npm
      // would otherwise rewrite the release's package-lock.json in its own format, and a changed
      // file blocks the next Update.
      method: "shell.run",
      params: {
        path: "../batshit-app",
        message: "npm prune --omit=dev --no-save --no-audit --no-fund"
      }
    },
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs install-redis"
      }
    },
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs prepare-data"
      }
    },
    {
      method: "shell.run",
      params: {
        message: "node lib/cli.mjs mark-installed"
      }
    },
    {
      method: "notify",
      params: {
        html: "Batshit is installed. Click <b>Start</b>, then create your admin account."
      }
    }
  ]
}
