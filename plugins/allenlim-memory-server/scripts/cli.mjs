#!/usr/bin/env node
/**
 * mem — CLI helper for the memory server (Agent Memory backed).
 *
 * Usage:
 *   node scripts/cli.mjs login                    # SSO login via Allen Labs auth server
 *   node scripts/cli.mjs logout                   # clear stored credentials
 *   node scripts/cli.mjs whoami                   # show current authenticated user
 *   node scripts/cli.mjs add "some fact" [--session sid]
 *   node scripts/cli.mjs search "query text"
 *   node scripts/cli.mjs ingest <conversation.json   # extract memories from conversation
 *   node scripts/cli.mjs list [--type fact] [--session sid] [--limit 50]
 *   node scripts/cli.mjs get <memory-id>
 *   node scripts/cli.mjs delete <memory-id>
 *   node scripts/cli.mjs delete-session <session-id>
 *   node scripts/cli.mjs summary [--session sid]
 *   node scripts/cli.mjs stats
 *
 * Environment:
 *   MEMORY_SERVER_URL  — worker URL (defaults to https://memory.allenlim.net)
 *   MEMORY_API_KEY     — API key (takes precedence over JWT credentials)
 *   MEMORY_TOKEN       — JWT bearer token (overrides credential file; for CI/headless)
 *   MEMORY_SCOPE       — scope header (optional)
 *   MEMORY_REQUEST_TIMEOUT_MS — request timeout in milliseconds (default 10000)
 */

import {
  getAuthenticationMode,
  getAuthApiUrl,
  getCachedOAuthClientRegistration,
  getCurrentUser,
  getMemoryResource,
  isLoggedIn,
  logout,
  memory,
  readBoundedJsonResponse,
  readStdin,
  saveOAuthClientRegistration,
  saveCredentialsWithLock,
} from "./lib.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { cmd, positional, flags };
}

/** OAuth native-app flow with an ephemeral loopback callback and PKCE S256. */
async function handleLogin(flags) {
  // Compatibility import for service-managed bootstrap flows.
  if (flags.pipe) {
    const input = await readStdin();
    const trimmed = input.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON — treat as a raw JWT
    }
    if (parsed !== undefined) {
      if (!parsed || typeof parsed !== "object" || typeof parsed.token !== "string") {
        throw new Error("Invalid token input. Expected a JWT or JSON containing a token.");
      }
      // Keep token validation and credential-write errors intact instead of
      // misclassifying them as JSON parse failures.
      await saveLoginResponse(parsed);
      console.log(`Logged in as ${parsed.user?.email ?? parsed.user?.id ?? "unknown"}`);
      return;
    }
    if (trimmed && trimmed.split(".").length === 3) {
      await saveCredentialsWithLock(trimmed, undefined, null);
      console.log("Token saved.");
      return;
    }
    throw new Error("Invalid token input. Expected a JWT or JSON containing a token.");
  }

  const authApiUrl = getAuthApiUrl();
  const resource = getMemoryResource();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await createLoopbackCallback(state);
  try {
    let registration = flags["new-client"]
      ? null
      : getCachedOAuthClientRegistration(authApiUrl);
    if (!registration) {
      const registrationResponse = await fetch(`${authApiUrl}/oauth/register`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "allenlim-memory-server CLI",
        // RFC 8252 loopback clients register a stable host/path and vary only
        // the ephemeral port used by each authorization request.
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope:
          "openid profile email offline_access memory:read memory:write memory:delete",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      });
      const registered = await readBoundedJsonResponse(registrationResponse);
      if (
        !registrationResponse.ok ||
        typeof registered.client_id !== "string" ||
        !registered.client_id ||
        Buffer.byteLength(registered.client_id, "utf8") > 1024
      ) {
        throw oauthResponseError("Client registration", registrationResponse, registered);
      }
      saveOAuthClientRegistration(authApiUrl, registered.client_id);
      registration = { clientId: registered.client_id };
    }

    const authorizeUrl = new URL(`${authApiUrl}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.clientId,
      redirect_uri: callback.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource,
      scope:
        "openid profile email offline_access memory:read memory:write memory:delete",
    }).toString();

    if (!flags["no-open"]) {
      console.log("Opening the secure sign-in page in your browser...");
    }
    if (flags["no-open"] || !await openBrowser(authorizeUrl.href)) {
      console.log(`Open this URL to sign in:\n${authorizeUrl.href}\n`);
    }
    const callbackResult = await callback.result;
    if (callbackResult.iss !== authApiUrl) {
      throw new Error("Authorization callback issuer mismatch.");
    }

    const tokenResponse = await fetch(`${authApiUrl}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callbackResult.code,
        redirect_uri: callback.redirectUri,
        client_id: registration.clientId,
        code_verifier: verifier,
        resource,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = await readBoundedJsonResponse(tokenResponse);
    if (
      !tokenResponse.ok ||
      tokens.token_type !== "Bearer" ||
      !tokens.access_token ||
      !tokens.refresh_token ||
      !Number.isSafeInteger(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      !Number.isSafeInteger(tokens.refresh_token_expires_in) ||
      tokens.refresh_token_expires_in <= 0 ||
      tokens.resource !== resource
    ) {
      throw oauthResponseError("Token exchange", tokenResponse, tokens);
    }
    await saveLoginResponse({
      ...tokens,
      token: tokens.access_token,
      client_id: registration.clientId,
    });
    console.log("Logged in. This session refreshes automatically for up to 30 days.");
  } finally {
    callback.close();
  }
}

async function handleLogout() {
  const revoked = await logout();
  console.log(
    revoked
      ? "Logged out. Renewable session revoked and local credentials removed."
      : "Logged out locally. The authorization server could not be reached; local credentials were removed.",
  );
}

function handleWhoami() {
  if (!isLoggedIn()) {
    console.log("Not authenticated. Set MEMORY_API_KEY or run `mem login` to sign in.");
    return;
  }
  if (getAuthenticationMode() === "api-key") {
    console.log("Authenticated with MEMORY_API_KEY.");
    return;
  }
  const user = getCurrentUser();
  if (user) {
    console.log(`Logged in as: ${user.email ?? user.id ?? "unknown"}`);
    if (user.name) console.log(`Name: ${user.name}`);
  } else {
    console.log("Authenticated (token stored, user info unavailable).");
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv);

  try {
    switch (cmd) {
      case "login":
        await handleLogin(flags);
        break;
      case "logout":
        await handleLogout();
        break;
      case "whoami":
        handleWhoami();
        break;
      case "add": {
        const content = positional.join(" ");
        if (!content) {
          console.error("Usage: mem add <content> [--session sid]");
          process.exit(1);
        }
        const result = await memory.add({
          content,
          sessionId: flags.session,
        });
        console.log(result);
        break;
      }
      case "search": {
        const query = positional.join(" ");
        if (!query) {
          console.error("Usage: mem search <query>");
          process.exit(1);
        }
        const result = await memory.search({
          query,
          thinkingLevel: flags.thinking,
          responseLength: flags.length,
        });
        const parsed = JSON.parse(result);
        console.log(`\nAnswer: ${parsed.answer ?? "(none)"}\n`);
        for (const c of parsed.candidates ?? []) {
          console.log(`  [${c.id}] (score: ${c.score?.toFixed?.(3) ?? c.score}) ${c.summary}`);
        }
        console.log(`\n${parsed.count ?? 0} candidate(s)`);
        break;
      }
      case "ingest": {
        // Read conversation JSON from stdin: [{role, content}, ...]
        const input = await readStdin();
        let messages;
        try {
          messages = JSON.parse(input);
        } catch {
          console.error("Usage: mem ingest < conversation.json\n  (JSON array of {role, content})");
          process.exit(1);
        }
        if (!Array.isArray(messages)) {
          console.error("Input must be a JSON array of {role, content} messages.");
          process.exit(1);
        }
        const result = await memory.ingest({
          messages,
          sessionId: flags.session,
        });
        console.log(result);
        break;
      }
      case "get": {
        const id = positional[0];
        if (!id) {
          console.error("Usage: mem get <memory-id>");
          process.exit(1);
        }
        const result = await memory.get({ id });
        console.log(result);
        break;
      }
      case "list": {
        const result = await memory.list({
          type: flags.type,
          sessionId: flags.session,
          limit: flags.limit ? parseInt(flags.limit, 10) : 50,
          cursor: flags.cursor,
        });
        const parsed = JSON.parse(result);
        for (const m of parsed.memories ?? []) {
          console.log(`${m.id}\t${m.type}\t${m.updatedAt}\t${truncate(m.summary, 60)}`);
        }
        console.log(`\n${parsed.count ?? 0} entr${(parsed.count ?? 0) === 1 ? "y" : "ies"}`);
        if (parsed.cursor) console.log(`(cursor: ${parsed.cursor})`);
        break;
      }
      case "delete": {
        const id = positional[0];
        if (!id) {
          console.error("Usage: mem delete <memory-id> [--yes]");
          process.exit(1);
        }
        await requireDeleteConfirmation(`Delete memory ${id}?`, flags);
        const result = await memory.delete({ id });
        console.log(result);
        break;
      }
      case "delete-session": {
        const sessionId = positional[0];
        if (!sessionId) {
          console.error("Usage: mem delete-session <session-id> [--yes]");
          process.exit(1);
        }
        await requireDeleteConfirmation(
          `Delete every memory in session ${sessionId}?`,
          flags,
        );
        const result = await memory.deleteSession({ sessionId });
        console.log(result);
        break;
      }
      case "summary": {
        const result = await memory.summary({ sessionId: flags.session });
        const parsed = JSON.parse(result);
        console.log(parsed.summary ?? result);
        break;
      }
      case "stats": {
        const result = await memory.stats();
        const parsed = JSON.parse(result);
        console.log(`Total: ${parsed.total}`);
        for (const [t, count] of Object.entries(parsed.byType ?? {})) {
          console.log(`  ${t}: ${count}`);
        }
        break;
      }
      case "hook": {
        const hookName = positional[0];
        const { runHook } = await import("./hook-runner.mjs");
        await runHook(hookName);
        break;
      }
      default:
        console.error(
          "Usage: mem <login|logout|whoami|add|search|ingest|get|list|delete|delete-session|summary|stats|hook> [args] [flags]",
        );
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + "…" : s;
}

async function saveLoginResponse(parsed) {
  await saveCredentialsWithLock(parsed.token, parsed.expires_in, parsed.user, {
    refreshToken: parsed.refresh_token,
    refreshTokenExpiresIn: parsed.refresh_token_expires_in,
    clientId: parsed.client_id,
    resource: parsed.resource,
  });
}

async function requireDeleteConfirmation(prompt, flags) {
  if (flags.yes === true) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Deletion requires an interactive terminal or the explicit --yes flag.");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`${prompt} [y/N] `);
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      throw new Error("Deletion cancelled.");
    }
  } finally {
    terminal.close();
  }
}

async function createLoopbackCallback(expectedState) {
  let settle;
  let rejectResult;
  let settled = false;
  let expectedHost;
  const result = new Promise((resolve, reject) => {
    settle = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        url.pathname !== "/callback" ||
        request.headers.host !== expectedHost
      ) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (settled) {
        response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization callback already received.");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      if (state !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization callback validation failed.");
        return;
      }
      if (oauthError || !code) {
        settled = true;
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization failed. You may close this tab.");
        rejectResult(new Error(
          oauthError ? `Authorization failed: ${oauthError}.` : "Authorization callback had no code.",
        ));
        return;
      }
      settled = true;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end("<!doctype html><meta charset=utf-8><title>Memory signed in</title><p>Signed in. You may close this tab.</p>");
      settle({ code, iss: url.searchParams.get("iss") });
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid authorization callback.");
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("Could not start the OAuth loopback callback.");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(new Error("Sign-in timed out after five minutes."));
    }
    server.close();
  }, 5 * 60 * 1000);
  timeout.unref?.();
  return {
    close() {
      clearTimeout(timeout);
      server.close();
    },
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    result,
  };
}

async function openBrowser(url) {
  try {
    const { execFile } = await import("node:child_process");
    const [command, args] = process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    await new Promise((resolve, reject) => {
      execFile(command, args, {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

function oauthResponseError(operation, response, payload) {
  const description = typeof payload?.error_description === "string"
    ? payload.error_description.slice(0, 500)
    : typeof payload?.error === "string"
      ? payload.error.slice(0, 100)
      : "request rejected";
  return new Error(`${operation} failed (${response.status}): ${description}.`);
}

main();
