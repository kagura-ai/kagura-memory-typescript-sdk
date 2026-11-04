/** Internal bridge between an SDK validation and immediate CLI formatting. */
import { readModel, type Model } from "./pyModels.js";
import { isDeepStrictEqual } from "node:util";

const views = new WeakMap<object, { model: Model; snapshot: object; dump: Record<string, unknown> }>();

/** Keep the validated dump beside the final public result, without adding fields. */
export function retainModelDump<T extends object>(result: T, model: Model, dump: Record<string, unknown>): T {
  try {
    views.set(result, { model, snapshot: structuredClone(result), dump });
  } catch {
    // Unknown server fields can be deeper than structuredClone accepts;
    // an optional optimization must not reject an otherwise valid reply.
    views.delete(result);
  }
  return result;
}

/**
 * Consume the SDK's snapshot for immediate formatting, or validate a custom
 * client's reply. This is not a validation cache: readModel always validates,
 * and no subsequent formatter can reuse this snapshot after consumption.
 */
export function modelDumpOf(result: unknown, model: Model, operation: string): Record<string, unknown> {
  if (typeof result === "object" && result !== null) {
    const view = views.get(result);
    views.delete(result);
    // A custom client can wrap an SDK method and edit its reply before the
    // CLI sees it. Preserve that behavior rather than printing a stale read.
    if (view?.model === model) {
      try {
        if (isDeepStrictEqual(result, view.snapshot)) return view.dump;
      } catch {
        // A wrapper can also add an arbitrarily deep value after validation.
      }
    }
  }
  return readModel(result, model, operation);
}
