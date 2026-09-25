import { describe, expect, it } from "vitest";

import { pathSegment } from "../src/pathSegment.js";

describe("pathSegment (#66)", () => {
  it("leaves an ordinary id as it is", () => {
    expect(pathSegment("products", "resourceId", "a resource id")).toBe("products");
    expect(pathSegment("3f2a-9c_x.y~z", "fileId", "a file id")).toBe("3f2a-9c_x.y~z");
  });

  it("encodes every character that would end or split the segment", () => {
    expect(pathSegment("a/b?c=d#e%f g", "fileId", "a file id")).toBe("a%2Fb%3Fc%3Dd%23e%25f%20g");
    // Dots inside a longer id are no dot segment.
    expect(pathSegment("..a", "fileId", "a file id")).toBe("..a");
    expect(pathSegment("...", "fileId", "a file id")).toBe("...");
  });

  it("encodes non-ASCII as UTF-8, and a lone surrogate as U+FFFD, as fetch does", () => {
    expect(pathSegment("日本", "fileId", "a file id")).toBe("%E6%97%A5%E6%9C%AC");
    expect(pathSegment("a\ud800b", "fileId", "a file id")).toBe("a%EF%BF%BDb");
    expect(pathSegment("\udc00", "fileId", "a file id")).toBe("%EF%BF%BD");
    expect(pathSegment("😀", "fileId", "a file id")).toBe("%F0%9F%98%80");
  });

  it.each([".", "..", ""])("refuses %j, which no encoding neutralizes", (value) => {
    expect(() => pathSegment(value, "fileId", "a file id")).toThrow(
      `fileId must be a file id, got ${JSON.stringify(value)}: as a URL path segment it ` +
        "would address a different endpoint",
    );
  });
});
