import { describe, expect, it } from "vitest";

import { pydanticDatetime } from "../src/pydanticDatetime.js";
import { DATETIME_CASES } from "./pydanticCases.js";

describe("pydanticDatetime: a datetime field as pydantic reads and writes it (#66)", () => {
  it.each(DATETIME_CASES)("%j", (input, expected) => {
    const got = pydanticDatetime(input);
    expect(got).toEqual("ok" in expected ? { ok: true, value: expected.ok } : { ok: false, msg: expected.err });
  });

  it("leaves memory-cloud's own form unchanged", () => {
    for (const text of ["2026-06-01T00:00:00Z", "2026-06-01T00:00:00.123456Z", "2026-06-01T09:00:00+09:00"]) {
      expect(pydanticDatetime(text)).toEqual({ ok: true, value: text });
    }
  });

  it("refuses a value that is no string and no number", () => {
    for (const value of [null, true, [], {}]) {
      expect(pydanticDatetime(value)).toEqual({ ok: false, msg: "Input should be a valid datetime" });
    }
  });
});
