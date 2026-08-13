import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("CLI --help prints usage and exits successfully", async () => {
  const result = await runCli(["--help"], {});

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Usage: mem </);
  assert.equal(result.stderr, "");
});

test("CLI missing and invalid commands remain usage errors", async () => {
  for (const arguments_ of [[], ["not-a-command"]]) {
    const result = await runCli(arguments_, {});

    assert.equal(result.code, 1, `arguments: ${JSON.stringify(arguments_)}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage: mem </);
  }
});

test("CLI exits nonzero when an MCP result reports isError", async (context) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-memory-api-key"], "test-api-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "simulated tool failure" }],
        },
      }),
    );
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runCli(["stats"], {
    MEMORY_API_KEY: "test-api-key",
    MEMORY_REQUEST_TIMEOUT_MS: "2000",
    MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Error: simulated tool failure/);
  assert.equal(result.stdout, "");
});

test("CLI bounds stdin before parsing ingest JSON", async () => {
  const result = await runCli(
    ["ingest"],
    { MEMORY_API_KEY: "test-api-key" },
    "x".repeat(4 * 1024 * 1024 + 1),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Standard input exceeded 4194304 bytes/);
});

test("CLI rejects oversized credential records before writing them", async () => {
  const testHome = join(tmpdir(), `memory-oversized-credentials-${process.pid}-${Date.now()}`);
  await mkdir(testHome, { recursive: true });
  const result = await runCli(
    ["login", "--pipe"],
    { HOME: testHome, USERPROFILE: testHome },
    JSON.stringify({
      token: jwtFor(
        "https://auth-api.allen.company",
        "https://memory.allenlim.net",
        "oversized-user",
        900,
      ),
      expires_in: 900,
      user: { name: "x".repeat(70 * 1024) },
    }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /credentials exceeded 65536 bytes/);
  await assert.rejects(
    readFile(join(testHome, ".memory", "credentials.json")),
    /ENOENT/,
  );
});

test("CLI deletion requires --yes when stdin is not a terminal", async (context) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "deleted" }] },
    }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  const environment = {
    MEMORY_API_KEY: "test-api-key",
    MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
  };
  const blocked = await runCli(["delete", "memory-id"], environment);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /interactive terminal.*--yes/);
  assert.equal(requests, 0);

  const misleading = await runCli(
    ["delete", "memory-id", "--yes", "false"],
    environment,
  );
  assert.equal(misleading.code, 1);
  assert.match(misleading.stderr, /interactive terminal.*--yes/);
  assert.equal(requests, 0);

  const accepted = await runCli(["delete", "memory-id", "--yes"], environment);
  assert.equal(accepted.code, 0);
  assert.equal(requests, 1);
});

test("CLI refreshes an expired access token and atomically stores rotation", async (context) => {
  let refreshCalls = 0;
  let mcpAuthorization;
  let origin;
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      const body = await collectRequest(request);
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "refresh-old");
      assert.equal(form.get("client_id"), "client-id");
      assert.equal(form.get("resource"), origin);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtFor(origin, origin, "fresh", 900),
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        refresh_token_expires_in: 30 * 24 * 60 * 60,
        resource: origin,
      }));
      return;
    }
    if (request.url === "/mcp") {
      mcpAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ total: 0 }) }] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;

  const testHome = join(tmpdir(), `memory-cli-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(join(credentialDir, "credentials.json"), JSON.stringify({
    token: jwtFor(origin, origin, "expired", -60),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "refresh-old",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "client-id",
    resource: origin,
    user: { id: "user-id" },
  }));

  const result = await runCli(["stats"], {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(refreshCalls, 1);
  assert.match(mcpAuthorization, /^Bearer /);
  const stored = JSON.parse(await readFile(join(credentialDir, "credentials.json"), "utf8"));
  assert.equal(stored.refreshToken, "refresh-new");
  assert.equal(stored.token, mcpAuthorization.slice("Bearer ".length));
  assert.deepEqual(
    (await readdir(credentialDir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    [],
  );
});

test("stored refresh credentials are never sent to a changed authorization server", async (context) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const testHome = join(tmpdir(), `memory-auth-rebind-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(join(credentialDir, "credentials.json"), JSON.stringify({
    token: jwtFor(
      "https://auth-api.allen.company",
      origin,
      "wrong-auth-origin",
      -60,
      "bound-client",
    ),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "must-not-leave-the-credential-file",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "bound-client",
    resource: origin,
  }));

  const result = await runCli(["stats"], {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  });
  assert.equal(result.code, 1);
  assert.equal(requests, 0);
  assert.doesNotMatch(result.stderr, /must-not-leave/);
});

test("CLI login uses loopback state and PKCE without exposing tokens", async (context) => {
  let origin;
  let registeredRedirect;
  let registrationCalls = 0;
  let authorizeUrl;
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/register") {
      registrationCalls += 1;
      const body = JSON.parse(await collectRequest(request));
      assert.equal(body.token_endpoint_auth_method, "none");
      assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
      assert.equal(body.redirect_uris.length, 1);
      registeredRedirect = body.redirect_uris[0];
      assert.equal(registeredRedirect, "http://127.0.0.1/callback");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ client_id: "public-cli-client" }));
      return;
    }
    if (request.url === "/oauth/token") {
      const form = new URLSearchParams(await collectRequest(request));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "public-cli-client");
      assert.equal(
        form.get("redirect_uri"),
        authorizeUrl.searchParams.get("redirect_uri"),
      );
      assert.equal(form.get("resource"), origin);
      const expectedChallenge = createHash("sha256")
        .update(form.get("code_verifier"))
        .digest("base64url");
      assert.equal(expectedChallenge, authorizeUrl.searchParams.get("code_challenge"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtFor(origin, origin, "login", 900, "public-cli-client"),
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "login-refresh-token",
        refresh_token_expires_in: 30 * 24 * 60 * 60,
        resource: origin,
      }));
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const testHome = join(tmpdir(), `memory-login-home-${process.pid}-${Date.now()}`);
  await mkdir(testHome, { recursive: true });

  const result = await runLoginAndAuthorize({
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  }, async (url) => {
    authorizeUrl = url;
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, "/oauth/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), origin);
    const callback = new URL(url.searchParams.get("redirect_uri"));
    const strayCallback = new URL(callback);
    strayCallback.searchParams.set("code", "attacker-code");
    strayCallback.searchParams.set("state", "wrong-state");
    const strayResponse = await fetch(strayCallback);
    assert.equal(strayResponse.status, 400);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("iss", origin);
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200);
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /login-refresh-token|\.signature/);
  const stored = JSON.parse(await readFile(join(testHome, ".memory", "credentials.json"), "utf8"));
  assert.equal(stored.refreshToken, "login-refresh-token");
  assert.equal(stored.clientId, "public-cli-client");
  assert.equal(stored.resource, origin);
  const cachedClient = JSON.parse(
    await readFile(join(testHome, ".memory", "oauth-client.json"), "utf8"),
  );
  assert.equal(cachedClient.clientId, "public-cli-client");
  assert.equal(cachedClient.redirectUri, "http://127.0.0.1/callback");

  // A fresh ephemeral callback port reuses the same recent public client.
  const second = await runLoginAndAuthorize({
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  }, async (url) => {
    authorizeUrl = url;
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "second-authorization-code");
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("iss", origin);
    assert.equal((await fetch(callback)).status, 200);
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(registrationCalls, 1);
});

test("CLI logout revokes the refresh family without exposing its token", async (context) => {
  let revokeForm;
  let origin;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/oauth/revoke");
    revokeForm = new URLSearchParams(await collectRequest(request));
    response.writeHead(200, { "cache-control": "no-store" });
    response.end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const testHome = join(tmpdir(), `memory-logout-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(join(credentialDir, "credentials.json"), JSON.stringify({
    token: jwtFor(origin, origin, "logout", 900, "logout-client"),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "secret-refresh-to-revoke",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "logout-client",
    resource: origin,
  }));

  const result = await runCli(["logout"], {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(revokeForm.get("token"), "secret-refresh-to-revoke");
  assert.equal(revokeForm.get("token_type_hint"), "refresh_token");
  assert.equal(revokeForm.get("client_id"), "logout-client");
  assert.equal(revokeForm.get("resource"), origin);
  await assert.rejects(readFile(join(credentialDir, "credentials.json")), /ENOENT/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-refresh-to-revoke/);
});

test("CLI logout removes local credentials when revocation fails", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_client" }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const testHome = join(tmpdir(), `memory-logout-fail-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(join(credentialDir, "credentials.json"), JSON.stringify({
    token: jwtFor(origin, origin, "logout-fail", 900, "bad-client"),
    refreshToken: "must-not-print",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "bad-client",
    resource: origin,
  }));
  const result = await runCli(["logout"], {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Logged out locally/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must-not-print/);
  await assert.rejects(readFile(join(credentialDir, "credentials.json")), /ENOENT/);
});

test("logout prevents a waiting refresh from recreating deleted credentials", async (context) => {
  let origin;
  let refreshCalls = 0;
  let releaseRevocation;
  let markRevocationReceived;
  const revocationReceived = new Promise((resolve) => {
    markRevocationReceived = resolve;
  });
  const revocationRelease = new Promise((resolve) => {
    releaseRevocation = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/revoke") {
      await collectRequest(request);
      markRevocationReceived();
      await revocationRelease;
      response.writeHead(200, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtFor(origin, origin, "resurrected", 900, "race-client"),
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "rotated-after-logout",
        refresh_token_expires_in: 86_400,
        resource: origin,
      }));
      return;
    }
    if (request.url === "/mcp") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ total: 0 }) }] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;

  const testHome = join(tmpdir(), `memory-logout-race-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  const credentialPath = join(credentialDir, "credentials.json");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(credentialPath, JSON.stringify({
    token: jwtFor(origin, origin, "expired-race", -60, "race-client"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "refresh-before-logout",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "race-client",
    resource: origin,
  }));
  const environment = {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  };

  const logoutResultPromise = runCli(["logout"], environment);
  await revocationReceived;
  const refreshResultPromise = runCli(["stats"], environment);
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseRevocation();

  const [logoutResult, refreshResult] = await Promise.all([
    logoutResultPromise,
    refreshResultPromise,
  ]);
  assert.equal(logoutResult.code, 0, logoutResult.stderr);
  assert.equal(refreshResult.code, 1);
  assert.match(refreshResult.stderr, /credentials were removed/);
  assert.equal(refreshCalls, 0);
  await assert.rejects(readFile(credentialPath), /ENOENT/);
});

test("an expired renewable session keeps the same transcript checkpoint identity", async (context) => {
  let origin;
  let refreshCalls = 0;
  let ingestCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      await collectRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtFor(origin, origin, "fresh-checkpoint", 900, "checkpoint-client"),
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "checkpoint-refresh-new",
        refresh_token_expires_in: 86_400,
        resource: origin,
      }));
      return;
    }
    if (request.url === "/mcp") {
      ingestCalls += 1;
      await collectRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "captured" }] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;

  const testHome = join(tmpdir(), `memory-checkpoint-refresh-home-${process.pid}-${Date.now()}`);
  const credentialDir = join(testHome, ".memory");
  const transcriptPath = join(testHome, "transcript.jsonl");
  await mkdir(credentialDir, { recursive: true });
  await writeFile(join(credentialDir, "credentials.json"), JSON.stringify({
    token: jwtFor(origin, origin, "expired-checkpoint", -60, "checkpoint-client"),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "checkpoint-refresh-old",
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientId: "checkpoint-client",
    resource: origin,
  }));
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "remember across refresh" },
    })}\n`,
  );
  const environment = {
    HOME: testHome,
    USERPROFILE: testHome,
    MEMORY_AUTH_API_URL: origin,
    MEMORY_SERVER_URL: origin,
  };
  const input = JSON.stringify({
    session_id: "checkpoint-refresh-session",
    transcript_path: transcriptPath,
  });

  const first = await runNodeScript("post-turn.mjs", [], environment, input);
  const second = await runNodeScript("post-turn.mjs", [], environment, input);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(refreshCalls, 1);
  assert.equal(ingestCalls, 1);
  const checkpointFiles = await readdir(join(credentialDir, "transcript-checkpoints"));
  assert.equal(checkpointFiles.filter((name) => name.endsWith(".json")).length, 1);
});

test("post-turn hook remains fail-open when an MCP ingest fails", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "simulated ingest failure" }],
        },
      }),
    );
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runNodeScript(
    "post-turn.mjs",
    [],
    {
      MEMORY_API_KEY: "test-api-key",
      MEMORY_REQUEST_TIMEOUT_MS: "2000",
      MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    JSON.stringify({
      messages: [{ role: "user", content: "remember this" }],
    }),
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /simulated ingest failure/);
});

test("standalone hooks remain fail-open when stdin exceeds the safety bound", async () => {
  const result = await runNodeScript(
    "post-turn.mjs",
    [],
    {},
    "x".repeat(4 * 1024 * 1024 + 1),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Standard input exceeded 4194304 bytes/);
});

test("post-turn falls back to direct messages when transcript setup fails", async (context) => {
  let receivedBody;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "captured" }] },
        }),
      );
    });
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const result = await runNodeScript(
    "post-turn.mjs",
    [],
    {
      MEMORY_API_KEY: "test-api-key",
      MEMORY_REQUEST_TIMEOUT_MS: "2000",
      MEMORY_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    JSON.stringify({
      transcript_path: join(
        tmpdir(),
        `missing-memory-transcript-${process.pid}-${Date.now()}.jsonl`,
      ),
      messages: [
        { role: "user", content: "fallback user message" },
        { role: "assistant", content: "fallback assistant message" },
      ],
    }),
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /Could not process the transcript/);
  assert.deepEqual(receivedBody.params.arguments.messages, [
    { role: "user", content: "fallback user message" },
    { role: "assistant", content: "fallback assistant message" },
  ]);
});

function runCli(arguments_, environment, input) {
  return runNodeScript("cli.mjs", arguments_, environment, input);
}

function runNodeScript(scriptName, arguments_, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(`./${scriptName}`, import.meta.url)), ...arguments_],
      {
        env: { ...process.env, ...environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

function runLoginAndAuthorize(environment, authorize) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "login", "--no-open"],
      { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let authorizationStarted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (authorizationStarted) return;
      const match = stdout.match(/https?:\/\/[^\s]+\/oauth\/authorize\?[^\s]+/);
      if (!match) return;
      authorizationStarted = true;
      authorize(new URL(match[0])).catch((error) => {
        child.kill();
        reject(error);
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function collectRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function jwtFor(issuer, audience, nonce, expiresInSeconds, clientId = "client-id") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    sub: "user-id",
    client_id: clientId,
    azp: clientId,
    token_use: "access",
    nonce,
  })}.signature`;
}
