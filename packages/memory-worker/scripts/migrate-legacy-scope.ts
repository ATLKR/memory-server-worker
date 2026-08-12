import {
  buildPersonalMigrationPlan,
  buildScopeMigrationPlan,
  migrateLegacyScopedProfile,
  type MigrationMemory,
  type ScopeMigrationClient,
} from "../src/migration";

interface CliOptions {
  ownerSub: string;
  logicalScope: string | null;
  personal: boolean;
  namespace: string;
  execute: boolean;
  confirmedOwnerSub: string;
}

function usage(): string {
  return `Usage:
  npm -w memory-worker run migrate:legacy-scope -- \\
    --owner-sub <JWT_SUB> --logical-scope <OLD_SCOPE> [--namespace memory]

  npm -w memory-worker run migrate:legacy-scope -- \\
    --owner-sub <JWT_SUB> --personal [--namespace memory]

The default is plan-only and performs no network requests or writes.
To copy active memories, add both:
  --execute --confirm-exclusive-owner <JWT_SUB>`;
}

function parseArguments(argv: string[]): CliOptions | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;

  const values = new Map<string, string>();
  let execute = false;
  let personal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (argument === "--personal") {
      personal = true;
      continue;
    }
    if (
      argument !== "--owner-sub" &&
      argument !== "--logical-scope" &&
      argument !== "--namespace" &&
      argument !== "--confirm-exclusive-owner"
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const logicalScope = values.get("--logical-scope")?.trim() || null;
  if (personal === (logicalScope !== null)) {
    throw new Error("Choose exactly one migration source: --personal or --logical-scope <OLD_SCOPE>");
  }

  return {
    ownerSub: values.get("--owner-sub") ?? "",
    logicalScope,
    personal,
    namespace: values.get("--namespace")?.trim() || "memory",
    execute,
    confirmedOwnerSub: values.get("--confirm-exclusive-owner") ?? "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AgentMemoryHttpClient implements ScopeMigrationClient {
  readonly #accountId: string;
  readonly #namespace: string;
  readonly #token: string;

  constructor(accountId: string, namespace: string, token: string) {
    this.#accountId = accountId;
    this.#namespace = namespace;
    this.#token = token;
  }

  #profileUrl(profileName: string): string {
    return (
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.#accountId)}` +
      `/agent-memory/namespaces/${encodeURIComponent(this.#namespace)}` +
      `/profiles/${encodeURIComponent(profileName)}`
    );
  }

  async #request(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    if (init?.body !== undefined) headers.set("content-type", "application/json");

    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || payload.success !== true) {
      throw new Error(`Cloudflare Agent Memory request failed (${response.status})`);
    }
    return payload;
  }

  async #getMemory(profileName: string, memoryId: string): Promise<MigrationMemory> {
    const payload = await this.#request(
      `${this.#profileUrl(profileName)}/memories/${encodeURIComponent(memoryId)}`,
    );
    const result = payload?.result;
    if (
      !isRecord(result) ||
      typeof result.id !== "string" ||
      typeof result.content !== "string" ||
      (result.sessionId !== null && typeof result.sessionId !== "string")
    ) {
      throw new Error("Cloudflare returned an invalid memory response");
    }
    return { id: result.id, content: result.content, sessionId: result.sessionId };
  }

  async listProfile(profileName: string): Promise<readonly MigrationMemory[]> {
    const memories: MigrationMemory[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const url = new URL(`${this.#profileUrl(profileName)}/memories`);
      url.searchParams.set("per_page", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const payload = await this.#request(url.toString());
      if (payload === null) return [];
      if (!Array.isArray(payload.result)) {
        throw new Error("Cloudflare returned an invalid memory list");
      }

      for (const entry of payload.result) {
        if (!isRecord(entry) || typeof entry.id !== "string") {
          throw new Error("Cloudflare returned an invalid memory list entry");
        }
        memories.push(await this.#getMemory(profileName, entry.id));
      }

      const resultInfo = payload.result_info;
      cursor = isRecord(resultInfo) && typeof resultInfo.cursor === "string"
        ? resultInfo.cursor
        : undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Cloudflare returned a repeated cursor");
        seenCursors.add(cursor);
      }
    } while (cursor);

    return memories;
  }

  async remember(
    profileName: string,
    memory: { content: string; sessionId: string | null },
  ): Promise<void> {
    await this.#request(`${this.#profileUrl(profileName)}/remember`, {
      method: "POST",
      body: JSON.stringify(memory),
    });
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    console.log(usage());
    return;
  }

  const plan = options.personal
    ? await buildPersonalMigrationPlan(options.ownerSub)
    : await buildScopeMigrationPlan(options.ownerSub, options.logicalScope!);
  if (!options.execute) {
    console.log(JSON.stringify({ mode: "plan-only", namespace: options.namespace, ...plan }, null, 2));
    console.log("No network request or write was performed. Audit exclusive source ownership before --execute.");
    return;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for --execute");
  }

  const result = await migrateLegacyScopedProfile(
    plan,
    options.confirmedOwnerSub,
    new AgentMemoryHttpClient(accountId, options.namespace, apiToken),
  );
  console.log(JSON.stringify({ mode: "copy-only", namespace: options.namespace, ...plan, ...result }, null, 2));
  console.log("The legacy source profile was not modified or deleted.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Legacy scope migration failed");
  console.error(usage());
  process.exitCode = 1;
});
