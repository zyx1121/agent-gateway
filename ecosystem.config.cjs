const { homedir } = require("node:os");
const { join } = require("node:path");

const home = homedir();
// Bun (channel runtime) usually lives in ~/.bun/bin and isn't on pm2's
// default PATH when launched via systemd. Splice the standard locations
// in front of whatever PATH pm2 inherits.
const PATH = [
  join(home, ".bun/bin"),
  join(home, ".local/bin"),
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

module.exports = {
  apps: [
    {
      name: "outpost",
      script: "dist/index.js",
      cwd: join(home, "outpost"),
      instances: 1,
      // Fork mode: pm2 reload becomes a hard restart (kill old → start new)
      // instead of zero-downtime, which would race two telegram pollers and
      // hit a 409 getUpdates conflict that silently kills update fetching.
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production", PATH },
      out_file: join(home, "outpost/logs/out.log"),
      error_file: join(home, "outpost/logs/err.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
