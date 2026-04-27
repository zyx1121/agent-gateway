module.exports = {
  apps: [
    {
      name: "agent-gateway",
      script: "dist/index.js",
      cwd: "/home/user/agent-gateway",
      instances: 1,
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
