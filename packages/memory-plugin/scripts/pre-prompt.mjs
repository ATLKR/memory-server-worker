#!/usr/bin/env node
/**
 * Pre-prompt hook (standalone entry point).
 *
 * Delegates to hook-runner.mjs which contains the actual logic.
 * This file exists so the hook can be invoked directly:
 *   node scripts/pre-prompt.mjs < hook-input.json
 */

import { runHook } from "./hook-runner.mjs";

runHook("pre-prompt");
