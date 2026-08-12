#!/usr/bin/env node
/**
 * Post-turn hook (standalone entry point).
 *
 * Delegates to hook-runner.mjs which contains the actual logic.
 * This file exists so the hook can be invoked directly:
 *   node scripts/post-turn.mjs < hook-input.json
 */

import { runHook } from "./hook-runner.mjs";

runHook("post-turn");
