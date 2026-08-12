// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getRouter } from "./router";

describe("SSR router isolation", () => {
  it("creates a fresh router for every request", () => {
    expect(getRouter()).not.toBe(getRouter());
  });
});
