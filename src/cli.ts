#!/usr/bin/env node
// CLI router for the `outpost` bin. Picks a subcommand and dynamic-imports
// only the modules that subcommand needs, so e.g. `outpost inject` does
// not touch config.ts (which would demand TELEGRAM_BOT_TOKEN) or bind the
// socket.

const HELP = `outpost — Run Claude Code as a daemon, talk to it from your phone.

Subcommands:
  (none)        boot the daemon (config from env / .env)
  inject ...    one-shot send to the running daemon's claude session
  -h, --help    this message
  -V, --version print version

For per-subcommand help: outpost <sub> --help
`;

const sub = process.argv[2];

if (sub === "-h" || sub === "--help") {
  process.stdout.write(HELP);
  process.exit(0);
}

if (sub === "-V" || sub === "--version") {
  // Lazily import package.json to avoid bundling concerns.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf-8"));
  process.stdout.write(`outpost ${pkg.version}\n`);
  process.exit(0);
}

if (sub === "inject") {
  const { runInjectCli } = await import("./inject.js");
  const code = await runInjectCli(process.argv.slice(3));
  process.exit(code);
}

// Default: boot the daemon. index.js runs side-effectfully on import.
await import("./index.js");
