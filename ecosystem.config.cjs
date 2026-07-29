/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

const projectRoot = __dirname;
const logsDir = path.join(projectRoot, "logs");
const nextCli = path.join(
  projectRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

module.exports = {
  apps: [
    {
      name: "veridia",
      cwd: projectRoot,
      script: nextCli,
      args: ["start", "-p", "3100"],
      interpreter: process.execPath,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 8000,
      windowsHide: true,
      env: {
        NODE_ENV: "production",
        PORT: "3100",
      },
      output: path.join(logsDir, "veridia-out.log"),
      error: path.join(logsDir, "veridia-error.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
