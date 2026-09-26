import { describe, expect, it } from "vitest";

import { formatDumpsJson, formatModelJson, pydanticFloat } from "../../src/cli/modelDump.js";
import { KaguraResponseError } from "../../src/errors.js";
import {
  INDEXER_STATUS_RESPONSE,
  PAGINATED_RESOURCE_TOKENS_RESPONSE,
  PyFloat,
  type Model,
  readModel,
  RESOURCE_EVENT_BATCH_RESPONSE,
  RESOURCE_EVENTS_LIST_RESPONSE,
  RESOURCE_SCHEMA_RESPONSE,
} from "../../src/pyModels.js";
import { parseJsonLossless } from "../../src/losslessJson.js";
import { FLOAT_CASES, JSON_NUMBER_CASES } from "../pydanticCases.js";

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

describe("formatModelJson: a lone surrogate, which pydantic cannot write as UTF-8 (#69)", () => {
  // Measured on pydantic 2.13.4: a string value holding a lone surrogate
  // fails the dump with CPython's UnicodeEncodeError text, the position a
  // code-point index, a run of them as `S-E`; a key is converted lossily.
  const refused = (where: string) =>
    `Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode ${where}: surrogates not allowed`;

  it.each([
    ["a high surrogate first", "\ud800", "character '\\ud800' in position 0"],
    ["a low surrogate third", "ab\udfff", "character '\\udfff' in position 2"],
    ["counted in code points: an astral character is one", "😀\ud800", "character '\\ud800' in position 1"],
    ["a run of lone surrogates as a range", "😀x\udc00\udc00y", "characters in position 2-3"],
    ["only the first run", "\ud800a\udc00", "character '\\ud800' in position 0"],
    ["a high surrogate at the end", "abc\udbff", "character '\\udbff' in position 3"],
  ])("refuses a string value holding %s", (_name, text, where) => {
    expect(failure(() => formatModelJson({ s: text })).message).toBe(refused(where));
    expect(failure(() => formatModelJson({ l: ["ok", text] })).message).toBe(refused(where));
    expect(failure(() => formatModelJson(parseJsonLossless(JSON.stringify({ p: { s: text } })))).message).toBe(
      refused(where),
    );
  });

  it("keeps a surrogate pair, one code point", () => {
    expect(formatModelJson({ s: "😀" })).toBe('{\n  "s": "😀"\n}');
  });

  // A key's fate depends on its level (measured the same way): the keys of
  // the `dict`-typed field's own mapping go through pydantic's `str` key
  // serializer, which converts a lone surrogate lossily; a mapping nested
  // inside the untyped value (in a list of it too) is inferred, and its key
  // is refused like a value, before the entry's value is looked at.

  /** An events page whose first event's `payload` is `payload`, the untyped mapping `readModel` marks. */
  const events = (payload: string) =>
    readModel(
      parseJsonLossless(`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": ${payload}}]}`),
      RESOURCE_EVENTS_LIST_RESPONSE,
      "ResourceClient.list_resource_events",
    );

  it("writes a lone surrogate in a key of the untyped mapping itself as pydantic's lossy conversion does, three U+FFFD each", () => {
    expect(formatModelJson(events('{"\\ud800": 1, "a\\udfff\\udc00b": 2}'))).toContain(
      '"payload": {\n        "���": 1,\n        "a������b": 2\n      }',
    );
  });

  it("converts the keys of each mapping of a list[dict] field the same way", () => {
    const batch = readModel(
      parseJsonLossless('{"created_count": 0, "errors": [{"\\ud800": 1}]}'),
      RESOURCE_EVENT_BATCH_RESPONSE,
      "ResourceClient.ingest_events",
    );
    expect(formatModelJson(batch)).toContain('"errors": [\n    {\n      "���": 1\n    }\n  ]');
  });

  it("refuses the value after converting a key of the untyped mapping itself, in pydantic's order", () => {
    expect(failure(() => formatModelJson(events('{"\\ud800": "a\\udfff"}'))).message).toBe(
      refused("character '\\udfff' in position 1"),
    );
  });

  it.each([
    ["a mapping nested in the untyped value", '{"p": {"\\ud800": 1}}', "character '\\ud800' in position 0"],
    ["a mapping in a list in the untyped value", '{"p": [{"\\ud800": 1}]}', "character '\\ud800' in position 0"],
    ["a nested mapping, a run in the key", '{"p": {"a\\udfff\\udc00b": 1}}', "characters in position 1-2"],
    ["a nested mapping, the key before its value", '{"p": {"\\ud800": "\\udfff"}}', "character '\\ud800' in position 0"],
    ["a nested mapping, the key before a later value", '{"p": {"a": "\\udfff", "\\ud800": 1}}', "character '\\udfff' in position 0"],
  ])("refuses a lone surrogate in a key of %s, as pydantic infers it", (_name, payload, where) => {
    expect(failure(() => formatModelJson(events(payload))).message).toBe(refused(where));
  });

  it("keys outside any untyped value are model field names: written as they are", () => {
    // No Python counterpart (a model's field names are fixed); the dumper leaves them alone.
    expect(formatModelJson({ "\ud800": 1 })).toBe('{\n  "���": 1\n}');
  });

  it("json.dumps has no such refusal: the CLI's errors=replace stdout prints ? per lone code unit", () => {
    // Recorded from the Python CLI 0.42.0: `_force_utf8_io` reconfigures
    // stdout with errors="replace", so the code unit json.dumps kept is `?`.
    expect(formatDumpsJson({ "\ud800": "a\udfff", p: { "\udbff": "\ud83d\ude00\udfff\ud800\ud800x\ud800\udc00" } })).toBe(
      '{\n  "?": "a?",\n  "p": {\n    "?": "\ud83d\ude00???x\ud800\udc00"\n  }\n}',
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

describe("readModel on a body read by parseJsonLossless (#69)", () => {
  const INT: Model = { name: "T", fields: [{ key: "v", kind: "int" }] };
  const FLOAT: Model = { name: "T", fields: [{ key: "v", kind: "float" }] };

  function dumpV(model: Model, literal: string): string {
    return formatModelJson(readModel(parseJsonLossless(`{"v": ${literal}}`), model, "op"));
  }

  it.each(JSON_NUMBER_CASES)("an int field and a float field sent %s read as pydantic reads them", (literal, int, float) => {
    for (const [model, expected] of [
      [INT, int],
      [FLOAT, float],
    ] as const) {
      if ("ok" in expected) {
        expect(dumpV(model, literal)).toBe(`{\n  "v": ${expected.ok}\n}`);
      } else {
        expect(() => dumpV(model, literal)).toThrow(
          new KaguraResponseError(`op: unexpected server response for T (v: ${expected.err}). ${HINT}`, "op"),
        );
      }
    }
  });

  it("reads each list item's literal, as in an event_ids list", () => {
    const read = (body: string) =>
      readModel(parseJsonLossless(body), RESOURCE_EVENT_BATCH_RESPONSE, "ResourceClient.ingest_events");
    expect(formatModelJson(read('{"created_count": 1, "event_ids": [9007199254740993, 2.0]}').event_ids)).toBe(
      "[\n  9007199254740993,\n  2\n]",
    );
    expect(() => read('{"created_count": 1, "event_ids": [1, 1e20]}')).toThrow(
      "(event_ids.1: Unable to parse input string as an integer, exceeded maximum size)",
    );
  });

  it("gives every other type the plain value", () => {
    const model: Model = {
      name: "T",
      fields: [
        { key: "s", kind: "str" },
        { key: "d", kind: "datetime" },
        { key: "m", kind: "dict" },
        { key: "l", kind: { list: "str" } },
        { key: "n", kind: { nullable: "float" } },
        { key: "lit", kind: { literal: ["a"] } },
      ],
    };
    expect(() =>
      readModel(parseJsonLossless('{"s": 1, "d": 0, "m": 1, "l": 1, "n": -0, "lit": 1}'), model, "op"),
    ).toThrow(
      "op: unexpected server response for T (s: Input should be a valid string; " +
        "m: Input should be a valid dictionary; l: Input should be a valid list (+1 more)).",
    );
    const read = readModel(parseJsonLossless('{"s": "x", "d": 0, "m": {}, "l": [], "n": -0, "lit": "a"}'), model, "op");
    expect(read.d).toBe("1970-01-01T00:00:00Z");
    expect(formatModelJson(read.n)).toBe("0.0");
  });
});

describe("an untyped mapping read by parseJsonLossless prints as Python read it (#69)", () => {
  const DICT: Model = { name: "T", fields: [{ key: "d", kind: "dict" }] };

  it.each(JSON_NUMBER_CASES)("%s in a dict[str, Any] and in json.dumps", (literal, _int, _float, untyped, dumps) => {
    const read = readModel(parseJsonLossless(`{"d": {"v": ${literal}}}`), DICT, "op");
    expect(formatModelJson(read)).toBe(`{\n  "d": {\n    "v": ${untyped}\n  }\n}`);
    expect(formatDumpsJson(parseJsonLossless(`{"v": ${literal}}`))).toBe(`{\n  "v": ${dumps}\n}`);
  });

  it("keeps the server's key order, nested and in lists", () => {
    const read = readModel(parseJsonLossless('{"d": {"b": 1, "2": [{"10": 3, "x": 0}], "id": "x"}}'), DICT, "op");
    expect(formatModelJson(read)).toBe(
      '{\n  "d": {\n    "b": 1,\n    "2": [\n      {\n        "10": 3,\n        "x": 0\n      }\n    ],\n    "id": "x"\n  }\n}',
    );
    expect(formatDumpsJson(parseJsonLossless('{"b": 1, "2": 2}'))).toBe('{\n  "b": 1,\n  "2": 2\n}');
  });

  it("prints a value changed since it was read as it now is", () => {
    const body = parseJsonLossless('{"a": 1.0, "b": 2}') as Record<string, unknown>;
    body.b = 2.5;
    body.c = 3;
    expect(formatDumpsJson(body)).toBe('{\n  "a": 1.0,\n  "b": 2.5,\n  "c": 3\n}');
  });

  it("json.dumps writes bigints exactly, a PyFloat as repr, and has no depth limit", () => {
    expect(formatDumpsJson({ n: 18014398509481986n, f: new PyFloat(1e-7), e: [], o: {} })).toBe(
      '{\n  "n": 18014398509481986,\n  "f": 1e-07,\n  "e": [],\n  "o": {}\n}',
    );
    const deep = parseJsonLossless(`{"d": {"x": ${"[".repeat(300)}1${"]".repeat(300)}}}`);
    expect(formatDumpsJson(deep).split("\n")).toHaveLength(2 * 302 + 1);
    expect(() => formatModelJson(readModel(deep, DICT, "op"))).toThrow(
      "Error serializing to JSON: ValueError: Circular reference detected (depth exceeded)",
    );
  });
});

describe("readModel: a lone surrogate in a non-str field (#69)", () => {
  it("refuses it in a Literal field with pydantic's string_unicode message", () => {
    const error = failure(() =>
      readModel({ events: [{ id: 1, op: "\u{d800}", doc_id: "d" }] }, RESOURCE_EVENTS_LIST_RESPONSE, "op"),
    );
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect(error.message).toBe(
      "op: unexpected server response for ResourceEventsListResponse (events.0.op: Input should be a " +
        `valid string, unable to parse raw data as a unicode string). ${HINT}`,
    );
  });
});
