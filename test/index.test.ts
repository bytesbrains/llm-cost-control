import { describe, expect, it } from "vitest";
import { hello } from "../src/index.js";

describe("hello", () => {
  it("returns the package name", () => {
    expect(hello()).toContain("bytesbrains");
  });
});
