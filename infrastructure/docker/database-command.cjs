const { spawn } = require("node:child_process");

function databaseUrl(env) {
  for (const key of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]) {
    if (!env[key] || /[<>\r\n]/.test(env[key]))
      throw new Error(`Set a non-placeholder ${key}`);
  }
  return `postgresql://${encodeURIComponent(env.POSTGRES_USER)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@postgres:5432/${encodeURIComponent(env.POSTGRES_DB)}`;
}
module.exports = { databaseUrl };
if (require.main === module) {
  try {
    const env = { ...process.env, DATABASE_URL: databaseUrl(process.env) };
    const [command, ...args] = process.argv.slice(2);
    if (!command) throw new Error("Missing database command");
    const child = spawn(command, args, { env, stdio: "inherit", shell: false });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      console.error("Database command could not start");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
