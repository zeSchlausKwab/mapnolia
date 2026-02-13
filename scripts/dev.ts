import { spawn, type Subprocess } from "bun";

const processes: Subprocess[] = [];

function colorize(name: string, color: string) {
  const colors: Record<string, string> = {
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    yellow: "\x1b[33m",
    reset: "\x1b[0m",
  };
  return `${colors[color] || ""}[${name}]${colors.reset}`;
}

async function runProcess(
  name: string,
  cmd: string[],
  color: string,
  cwd?: string
) {
  const prefix = colorize(name.padEnd(8), color);

  const proc = spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  processes.push(proc);

  // Stream stdout
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.trim()) console.log(`${prefix} ${line}`);
      }
    }
  })();

  // Stream stderr
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.trim()) console.error(`${prefix} ${line}`);
      }
    }
  })();

  return proc;
}

async function main() {
  console.log("🗺️  Starting mapnolia development environment...\n");

  // Start all services
  await Promise.all([
    runProcess("relay", ["nak", "serve"], "yellow"),
    runProcess("backend", ["go", "run", "."], "magenta", "./server"),
    runProcess("frontend", ["bun", "--hot", "src/index.ts"], "cyan"),
  ]);

  console.log("\n✅ All services started:");
  console.log("   Frontend:  http://localhost:3001");
  console.log("   Backend:   http://localhost:3544");
  console.log("   Relay:     ws://localhost:10547");
  console.log("\nPress Ctrl+C to stop all services\n");

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Shutting down...");
    for (const proc of processes) {
      proc.kill();
    }
    process.exit(0);
  });

  // Wait for all processes
  await Promise.all(processes.map((p) => p.exited));
}

main().catch(console.error);
