import { describe, expect, it } from "vitest";
import { localMvpName } from "../src/smoke";

describe("local MVP foundation", () => {
  it("loads the application module", () => {
    expect(localMvpName).toBe("Personal Intelligence Feed");
  });
});
