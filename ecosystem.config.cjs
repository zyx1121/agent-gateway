module.exports = {
  apps: [
    {
      name: "agent-gateway",
      script: "dist/index.js",
      cwd: "/home/user/agent-gateway",
      instances: 1,
      // Fork mode: pm2 reload becomes a hard restart (kill old → start new)
      // instead of zero-downtime, which would race two telegram pollers and
      // hit a 409 getUpdates conflict that silently kills update fetching.
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
      out_file: "/home/user/agent-gateway/logs/out.log",
      error_file: "/home/user/agent-gateway/logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
