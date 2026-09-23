const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { databaseUrl } = require("./database-command.cjs");
const root = resolve(__dirname, "../..");

test("database URL encodes credentials and always targets Compose PostgreSQL", () => {
  const env = {
    POSTGRES_USER: "test user",
    POSTGRES_PASSWORD: "test@:/?#%value",
    POSTGRES_DB: "test/db",
    DATABASE_URL: "must-not-be-used",
  };
  const url = new URL(databaseUrl(env));
  assert.equal(url.hostname, "postgres");
  assert.equal(url.port, "5432");
  assert.equal(decodeURIComponent(url.username), env.POSTGRES_USER);
  assert.equal(decodeURIComponent(url.password), env.POSTGRES_PASSWORD);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), env.POSTGRES_DB);
});
test("missing and placeholder settings fail without leaking values", () => {
  for (const value of [undefined, "", "<password>", "private\nvalue"]) {
    assert.throws(
      () =>
        databaseUrl({
          POSTGRES_USER: "test",
          POSTGRES_DB: "test",
          POSTGRES_PASSWORD: value,
        }),
      { message: "Set a non-placeholder POSTGRES_PASSWORD" },
    );
  }
});
test("rendered Compose retains private services, startup ordering and volumes", () => {
  const model = JSON.parse(
    execFileSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const { services } = model;
  assert.deepEqual(Object.keys(services).sort(), [
    "api",
    "migrate",
    "nginx",
    "postgres",
    "web",
  ]);
  for (const name of ["api", "migrate", "postgres", "web"])
    assert.ok(!services[name].ports?.length);
  assert.equal(services.nginx.ports[0].host_ip, "127.0.0.1");
  assert.equal(
    services.api.depends_on.migrate.condition,
    "service_completed_successfully",
  );
  assert.equal(
    services.migrate.depends_on.postgres.condition,
    "service_healthy",
  );
  for (const name of ["api", "web"])
    assert.equal(services.nginx.depends_on[name].condition, "service_healthy");
  assert.equal(services.api.volumes[0].source, "storage_data");
  assert.equal(
    services.api.volumes[0].target,
    services.api.environment.LOCAL_STORAGE_ROOT,
  );
  assert.equal(services.postgres.volumes[0].source, "postgres_data");
  for (const name of ["web", "nginx", "migrate"])
    assert.ok(!services[name].volumes?.length);
  assert.equal(
    services.api.environment.POSTGRES_DB,
    services.migrate.environment.POSTGRES_DB,
  );
  assert.equal(services.api.environment.CORS_ORIGINS, "http://localhost:8080");
  assert.equal(services.api.environment.CORS_CREDENTIALS, "false");
  assert.equal(
    services.nginx.environment.NGINX_ENVSUBST_FILTER,
    "^NGINX_MAX_BODY_BYTES",
  );
  assert.equal(
    String(services.web.build.args.NEXT_PUBLIC_UPLOAD_MAX_BYTES),
    services.api.environment.UPLOAD_MAX_BYTES,
  );
});
test("proxy preserves API paths, streaming and hides the storage volume", () => {
  const nginx = readFileSync(
    resolve(root, "infrastructure/nginx/default.conf.template"),
    "utf8",
  );
  assert.match(nginx, /proxy_pass http:\/\/\$api_upstream\$request_uri;/);
  assert.match(nginx, /proxy_request_buffering off;/);
  assert.match(nginx, /proxy_buffering off;/);
  assert.doesNotMatch(nginx, /\b(alias|root)\s|\/data\/brainless/);
  const ignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
  assert.match(ignore, /\*\*\/\.env/);
  assert.match(ignore, /\*\*\/\.next/);
});

test("Nginx limit script handles bounded decimal values and rejects injection", (t) => {
  const { existsSync } = require("node:fs");
  const shell =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/sh";
  if (!existsSync(shell)) return t.skip("POSIX shell unavailable");
  const command =
    '. infrastructure/nginx/19-upload-limit.envsh; printf "%s" "$NGINX_MAX_BODY_BYTES"';
  for (const [value, expected] of [
    ["52428800", "53477376"],
    ["000000008", "1048584"],
    ["209715200", "210763776"],
  ]) {
    const result = execFileSync(shell, ["-c", command], {
      cwd: root,
      env: { ...process.env, UPLOAD_MAX_BYTES: value },
      encoding: "utf8",
    });
    assert.equal(result, expected);
  }
  for (const value of [
    "",
    "0",
    "209715201",
    "1;echo unsafe",
    "<placeholder>",
  ]) {
    assert.throws(() =>
      execFileSync(shell, ["-c", command], {
        cwd: root,
        env: { ...process.env, UPLOAD_MAX_BYTES: value },
        stdio: "pipe",
      }),
    );
  }
});
