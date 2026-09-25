import { describe, expect, it } from "vitest";

import { formatModelJson, pydanticFloat } from "../../src/cli/modelDump.js";
import { KaguraResponseError } from "../../src/errors.js";
import {
  INDEXER_STATUS_RESPONSE,
  PAGINATED_RESOURCE_TOKENS_RESPONSE,
  PyFloat,
  readModel,
  RESOURCE_EVENT_BATCH_RESPONSE,
  RESOURCE_EVENTS_LIST_RESPONSE,
  RESOURCE_SCHEMA_RESPONSE,
} from "../../src/pyModels.js";
import { FLOAT_CASES } from "../pydanticCases.js";

const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

function failure(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

describe("pydanticFloat: a float as pydantic's JSON writes it (#66)", () => {
  it.each(FLOAT_CASES)("%s -> %s", (repr, json) => {
    expect(pydanticFloat(Number(repr))).toBe(json);
  });

  it("writes NaN and the infinities as null, pydantic's default", () => {
    expect([NaN, Infinity, -Infinity].map(pydanticFloat)).toEqual(["null", "null", "null"]);
  });
});

describe("formatModelJson: model_dump_json(indent=2)", () => {
  it("indents as pydantic does, with [] and {} for empty containers", () => {
    expect(formatModelJson({ a: [], b: {}, c: [1, { d: null }], e: "x" })).toBe(
      '{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    {\n      "d": null\n    }\n  ],\n  "e": "x"\n}',
    );
    expect(formatModelJson({})).toBe("{}");
    expect(formatModelJson([])).toBe("[]");
  });

  it("writes a float field as a float, and an untyped number by its kind", () => {
    expect(formatModelJson({ f: new PyFloat(1), g: new PyFloat(1e-6), n: 1, x: 0.5, big: 1e21 })).toBe(
      '{\n  "f": 1.0,\n  "g": 1e-6,\n  "n": 1,\n  "x": 0.5,\n  "big": 1000000000000000000000\n}',
    );
  });

  it("writes a bigint exactly", () => {
    expect(formatModelJson({ id: 123456789012345678901n })).toBe('{\n  "id": 123456789012345678901\n}');
  });

  it("escapes strings as pydantic does: controls, quote and backslash, nothing past ASCII", () => {
    expect(formatModelJson({ s: 'é日 \u007f"\\\n\u0000\u001b' })).toBe(
      '{\n  "s": "é日 \u007f\\"\\\\\\n\\u0000\\u001b"\n}',
    );
  });
});

describe("readModel: a payload as the Python model reads it", () => {
  it("fills defaults, drops unknown keys and keeps the model's order", () => {
    const page = readModel(
      { next_cursor: "c", extra: 1, events: [{ doc_id: "d", op: "upsert", id: "123456789012345678901", x: 1 }] },
      RESOURCE_EVENTS_LIST_RESPONSE,
      "ResourceClient.list_resource_events",
    );
    expect(formatModelJson(page)).toBe(
      [
        "{",
        '  "events": [',
        "    {",
        '      "id": 123456789012345678901,',
        '      "op": "upsert",',
        '      "doc_id": "d",',
        '      "version": null,',
        '      "idempotency_key": null,',
        '      "importance": null,',
        '      "created_at": null,',
        '      "payload": null,',
        '      "event_metadata": {},',
        '      "payload_bytes": null,',
        '      "payload_truncated": false',
        "    }",
        "  ],",
        '  "next_cursor": "c"',
        "}",
      ].join("\n"),
    );
  });

  it("gives each read its own default list and mapping", () => {
    const a = readModel({ resource_id: "r" }, INDEXER_STATUS_RESPONSE, "op");
    const b = readModel({ resource_id: "r" }, INDEXER_STATUS_RESPONSE, "op");
    expect(a.recent_events).toEqual([]);
    expect(a.recent_events).not.toBe(b.recent_events);
  });

  it("lists every problem in pydantic's words and order, nested locations included", () => {
    // What pydantic 2.13 reports for the same payload.
    const error = failure(() =>
      readModel(
        {
          tokens: [
            5,
            { id: "x", resource_id: 3, quota_events_per_hour: 1.5, created_at: true, is_active: "maybe", status: "on" },
          ],
          total: 1,
        },
        PAGINATED_RESOURCE_TOKENS_RESPONSE,
        "ResourceClient.list_tokens",
      ),
    );
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as KaguraResponseError).operation).toBe("ResourceClient.list_tokens");
    expect(error.message).toBe(
      "ResourceClient.list_tokens: unexpected server response for PaginatedResourceTokensResponse " +
        "(tokens.0: Input should be a valid dictionary or instance of ResourceTokenResponse; " +
        "tokens.1.id: Input should be a valid integer, unable to parse string as an integer; " +
        `tokens.1.resource_id: Input should be a valid string (+6 more)). ${HINT}`,
    );
  });

  it("words a Literal as pydantic does", () => {
    const error = failure(() =>
      readModel(
        {
          resource_id: "r",
          schema_version: 1,
          created_at: "2026-06-01T00:00:00Z",
          field_definitions: [{ name: "a", type: "x", description: "d", classification: "y" }],
        },
        RESOURCE_SCHEMA_RESPONSE,
        "ResourceClient.get_resource_schema",
      ),
    );
    expect(error.message).toBe(
      "ResourceClient.get_resource_schema: unexpected server response for ResourceSchemaResponse " +
        "(field_definitions.0.type: Input should be 'text', 'number', 'boolean', 'date', 'array' or 'object'; " +
        "field_definitions.0.classification: Input should be 'public', 'internal', 'pii' or 'confidential'). " +
        HINT,
    );
  });

  it("refuses a payload that is no object in the model's words", () => {
    const error = failure(() => readModel([1], INDEXER_STATUS_RESPONSE, "ResourceClient.get_indexer_status"));
    expect(error.message).toBe(
      "ResourceClient.get_indexer_status: unexpected server response for IndexerStatusResponse " +
        `(Input should be a valid dictionary or instance of IndexerStatusResponse). ${HINT}`,
    );
  });
});

describe("formatModelJson: pydantic's serializer depth in an untyped value", () => {
  // pydantic refuses to serialize a dict[str, Any] value once 256 non-empty
  // containers nest inside it, the value itself the first; an empty one and
  // the typed levels around it do not count (measured on pydantic 2.13.4).
  const DEPTH = "Error serializing to JSON: ValueError: Circular reference detected (depth exceeded)";
  const wrap = (n: number, inner: unknown, box: (v: unknown) => unknown): unknown => {
    let value = inner;
    for (let i = 0; i < n; i++) value = box(value);
    return value;
  };
  const lists = (n: number, inner: unknown) => wrap(n, inner, (v) => [v]);
  const dicts = (n: number, inner: unknown) => wrap(n, inner, (v) => ({ k: v }));
  const events = (payload: unknown) =>
    readModel({ events: [{ id: 1, op: "upsert", doc_id: "d", payload }] }, RESOURCE_EVENTS_LIST_RESPONSE, "op");
  const errors = (item: unknown) =>
    readModel({ created_count: 0, errors: [item] }, RESOURCE_EVENT_BATCH_RESPONSE, "op");

  it.each([
    ["payload {x: n lists around 1}", (n: number) => events({ x: lists(n, 1) }), 255],
    ["payload {x: n lists around []}", (n: number) => events({ x: lists(n, []) }), 255],
    ["payload {x: n lists around [1]}", (n: number) => events({ x: lists(n, [1]) }), 254],
    ["payload {x: n dicts around {}}", (n: number) => events({ x: dicts(n, {}) }), 255],
    ["payload as n dicts", (n: number) => events(dicts(n, 1)), 256],
    ["an errors item as n dicts", (n: number) => errors(dicts(n, 1)), 256],
    ["payload {x, y: n lists each}", (n: number) => events({ x: lists(n, 1), y: lists(n, 1) }), 255],
  ] as const)("%s: fails at pydantic's limit, not one before", (_name, make, failsAt) => {
    expect(() => formatModelJson(make(failsAt - 1))).not.toThrow();
    const error = failure(() => formatModelJson(make(failsAt)));
    expect(error.message).toBe(DEPTH);
  });

  it("refuses a payload far deeper than the stack, rather than overflowing it", () => {
    expect(failure(() => formatModelJson(events({ x: lists(100_000, 1) }))).message).toBe(DEPTH);
  });
});
