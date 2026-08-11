#!/usr/bin/env node
/**
 * mem — CLI helper for the memory server.
 *
 * Usage:
 *   node scripts/cli.mjs login                    # SSO login via Allen Labs auth server
 *   node scripts/cli.mjs logout                   # clear stored credentials
 *   node scripts/cli.mjs whoami                   # show current authenticated user
 *   node scripts/cli.mjs add "some fact" --key my-fact --namespace facts --tags a,b
 *   node scripts/cli.mjs search "query text"
 *   node scripts/cli.mjs get my-fact
 *   node scripts/cli.mjs list --namespace facts
 *   node scripts/cli.mjs update my-fact --content "updated" --append
 *   node scripts/cli.mjs delete my-fact
 *   node scripts/cli.mjs load my-doc
 *   node scripts/cli.mjs stats
 *
 * Environment:
 *   MEMORY_SERVER_URL  — worker URL (required)
 *   MEMORY_TOKEN       — JWT bearer token (overrides credential file; for CI/headless)
 *   MEMORY_SCOPE       — scope header (optional)
 */

import { memory, saveCredentials, getCurrentUser, isLoggedIn, logout } from "./lib.mjs";

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
 * SSO login flow:
 *   1. Start a local HTTP server on a random port to receive the callback.
 *   2. Open the browser to {MEMORY_SERVER_URL}/auth/sso?callback=http://localhost:<port>
 *      ... but actually the worker's /auth/sso handles the redirect to the
 *      auth web UI. We need the callback to come back to the worker's
 *      /auth/callback, which returns JSON with the JWT.
 *
 * Since the worker's /auth/callback returns JSON (not a redirect), the
 * browser will display the JSON. The user copies the token from the browser
 * and pastes it here. Alternatively, we can spin up a local server and
 * have the auth flow redirect to localhost — but that requires the
 * localhost origin to be in TRUSTED_ORIGINS on the auth server.
 *
 * Simplest approach that works without modifying auth server config:
 *   - Open browser to {MEMORY_SERVER_URL}/auth/sso
 *   - After login, the browser lands on /auth/callback which returns JSON
 *   - The user copies the JSON (or just the token) and pastes it here
 *
 * For a smoother UX, the user can also pipe the token directly:
 *   echo '{"token":"...","expires_in":28800}' | mem login --pipe
 *   echo "<jwt>" | mem login --pipe
 */
async function handleLogin(flags) {
  const serverUrl = (process.env.MEMORY_SERVER_URL ?? "").replace(/\/$/, "");
  if (!serverUrl) {
    console.error("MEMORY_SERVER_URL is not set. Set it in your environment or .env file.");
    process.exit(1);
  }

  // --pipe: read token from stdin (for headless/CI or paste flow).
  if (flags.pipe) {
    const input = await readStdin();
    const trimmed = input.trim();
    try {
      // Try parsing as the JSON response from /auth/callback
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

  // Browser flow: open the worker's SSO start endpoint.
  const ssoUrl = `${serverUrl}/auth/sso`;
  console.log(`\nOpening browser to sign in:\n  ${ssoUrl}\n`);
  console.log(
    "After signing in, your browser will show a JSON response with your token.\n" +
      "Copy the entire JSON and paste it here (or use --pipe):\n",
  );

  // Try to open the browser.
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

  // Read pasted input from stdin.
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

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    // Handle Ctrl-D / empty stdin
    process.stdin.on("close", () => resolve(data));
  });
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
          console.error("Usage: mem add <content> [--key k] [--namespace ns] [--tags a,b]");
          process.exit(1);
        }
        const tags = flags.tags ? String(flags.tags).split(",").map((t) => t.trim()) : [];
        const result = await memory.add({
          content,
          key: flags.key,
          namespace: flags.namespace,
          tags,
          metadata: flags.metadata ? JSON.parse(flags.metadata) : {},
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
          namespace: flags.namespace,
          limit: flags.limit ? parseInt(flags.limit, 10) : 10,
        });
        const parsed = JSON.parse(result);
        for (const m of parsed.results ?? []) {
          console.log(`\n[${m.key ?? m.id}] (${m.namespace})${m.tags?.length ? " " + m.tags.join(",") : ""}`);
          console.log(m.content);
        }
        console.log(`\n${parsed.count ?? 0} result(s)`);
        break;
      }
      case "get": {
        const key = positional[0];
        if (!key) {
          console.error("Usage: mem get <key>");
          process.exit(1);
        }
        const result = await memory.get({ key });
        console.log(result);
        break;
      }
      case "list": {
        const result = await memory.list({
          namespace: flags.namespace,
          tag: flags.tag,
          limit: flags.limit ? parseInt(flags.limit, 10) : 50,
        });
        const parsed = JSON.parse(result);
        for (const m of parsed.results ?? []) {
          console.log(`${m.key ?? m.id}\t${m.namespace}\t${m.updatedAt}\t${truncate(m.content, 60)}`);
        }
        console.log(`\n${parsed.count ?? 0} entr${(parsed.count ?? 0) === 1 ? "y" : "ies"}`);
        break;
      }
      case "update": {
        const key = positional[0];
        if (!key) {
          console.error("Usage: mem update <key> [--content c] [--tags a,b] [--append]");
          process.exit(1);
        }
        const tags = flags.tags ? String(flags.tags).split(",").map((t) => t.trim()) : undefined;
        const result = await memory.update({
          key,
          content: flags.content ?? positional.slice(1).join(" "),
          tags,
          metadata: flags.metadata ? JSON.parse(flags.metadata) : undefined,
          appendContent: Boolean(flags.append),
        });
        console.log(result);
        break;
      }
      case "delete": {
        const key = positional[0];
        if (!key) {
          console.error("Usage: mem delete <key>");
          process.exit(1);
        }
        const result = await memory.delete({ key });
        console.log(result);
        break;
      }
      case "load": {
        const key = positional[0];
        if (!key) {
          console.error("Usage: mem load <key>");
          process.exit(1);
        }
        const result = await memory.load({ key });
        console.log(result);
        break;
      }
      case "stats": {
        const result = await memory.stats();
        console.log(result);
        break;
      }
      case "hook": {
        // Subcommand for lifecycle hooks — reads stdin JSON and outputs
        // the hook-specific JSON response. Used by hooks.json in plugins.
        const hookName = positional[0];
        const { runHook } = await import("./hook-runner.mjs");
        await runHook(hookName);
        break;
      }
      default:
        console.error(
          "Usage: mem <login|logout|whoami|add|search|get|list|update|delete|load|stats|hook> [args] [flags]",
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
