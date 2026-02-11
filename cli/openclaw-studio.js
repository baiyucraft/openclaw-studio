#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");

const parseArgs = (argv) => {
  const args = { port: null, host: null, dev: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      args.port = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--host") {
      args.host = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--prod" || arg === "--production") {
      args.dev = false;
      continue;
    }
    if (arg === "--dev") {
      args.dev = true;
      continue;
    }
  }
  return args;
};

const resolvePort = (raw) => {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0) return null;
  return String(port);
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = resolvePort(args.port) ?? "3000";
  const host = String(args.host ?? "").trim() || "127.0.0.1";

  const rootDir = path.resolve(__dirname, "..");
  const serverPath = path.join(rootDir, "server", "index.js");

  const child = spawn(
    process.execPath,
    [serverPath, ...(args.dev ? ["--dev"] : [])],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        HOST: host,
        PORT: port,
      },
    }
  );

  child.on("exit", (code) => {
    process.exitCode = typeof code === "number" ? code : 1;
  });
}

main();

