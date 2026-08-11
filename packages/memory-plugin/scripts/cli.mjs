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
 *   MEMORY_SERVER_URL  — worker URL (required)
 *   MEMORY_TOKEN       — JWT bearer token (overrides credential file; for CI/headless)
 *   MEMORY_SCOPE       — scope header (optional)
 */

import { memory, saveCredentials, getCurrentUser, isLoggedIn, logout, readStdin } from "./lib.mjs";

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

/**
 * SSO login flow — same as before. Opens browser to /auth/sso, user pastes
 * the JSON response from /auth/callback.
 */
async function handleLogin(flags) {
  const serverUrl = (process.env.MEMORY_SERVER_URL ?? "").replace(/\/$/, "");
  if (!serverUrl) {
    console.error("MEMORY_SERVER_URL is not set. Set it in your environment or .env file.");
    process.exit(1);
  }

  if (flags.pipe) {
    const input = await readStdin();
    const trimmed = input.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.token) {
        saveCredentials(parsed.token, parsed.expires_in, parsed.user);
        console.log(`Logged in as ${parsed.user?.email ?? parsed.user?.id ?? "unknown"}`);
        return;
      }
    } catch {
      // Not JSON — treat as a raw JWT
    }
    if (trimmed && trimmed.split(".").length === 3) {
      saveCredentials(trimmed, 8 * 60 * 60, null);
      console.log("Token saved.");
      return;
    }
    console.error("Invalid token input. Expected a JWT or JSON from /auth/callback.");
    process.exit(1);
  }

  const ssoUrl = `${serverUrl}/auth/sso`;
  console.log(`\nOpening browser to sign in:\n  ${ssoUrl}\n`);
  console.log(
    "After signing in, your browser will show a JSON response with your token.\n" +
      "Copy the entire JSON and paste it here (or use --pipe):\n",
  );

  try {
    const { execSync } = await import("node:child_process");
    const platform = process.platform;
    if (platform === "win32") {
      execSync(`start "" "${ssoUrl}"`, { stdio: "ignore" });
    } else if (platform === "darwin") {
      execSync(`open "${ssoUrl}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${ssoUrl}"`, { stdio: "ignore" });
    }
  } catch {
    console.log(`(Could not auto-open browser. Open the URL manually.)\n`);
  }

  const input = await readStdin();
  const trimmed = input.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.token) {
      saveCredentials(parsed.token, parsed.expires_in, parsed.user);
      console.log(`\nLogged in as ${parsed.user?.email ?? parsed.user?.id ?? "unknown"}`);
      return;
    }
  } catch {
    // Not JSON
  }
  if (trimmed && trimmed.split(".").length === 3) {
    saveCredentials(trimmed, 8 * 60 * 60, null);
    console.log("\nToken saved.");
    return;
  }
  console.error("\nInvalid token input. Expected a JWT or JSON from /auth/callback.");
  process.exit(1);
}

function handleLogout() {
  logout();
  console.log("Logged out. Credentials removed.");
}

function handleWhoami() {
  if (!isLoggedIn()) {
    console.log("Not authenticated. Run `mem login` to sign in.");
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
        handleLogout();
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
          console.error("Usage: mem delete <memory-id>");
          process.exit(1);
        }
        const result = await memory.delete({ id });
        console.log(result);
        break;
      }
      case "delete-session": {
        const sessionId = positional[0];
        if (!sessionId) {
          console.error("Usage: mem delete-session <session-id>");
          process.exit(1);
        }
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
    process.exit(1);
  }
}

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + "…" : s;
}

main();
