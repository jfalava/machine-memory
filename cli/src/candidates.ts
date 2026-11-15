import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Schema } from "effect";

import type { JsonObject } from "./json";

const decodeCandidates = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)),
  ),
);

/**
 * Adds one candidate memory to the JSON array in `path`, creating the file,
 * and returns how many candidates the file now holds. A child agent collects
 * its findings there; the parent writes them with `import <path> --review`.
 */
export function appendCandidate(path: string, candidate: JsonObject): number {
  const file = resolve(process.cwd(), path);
  let candidates: JsonObject[] = [];
  if (existsSync(file)) {
    try {
      candidates = [...decodeCandidates(readFileSync(file, "utf8"))];
    } catch (cause) {
      throw new Error(
        `${path} is not a candidate file: it must hold a JSON array of memories. Name another file, or delete it.`,
        { cause },
      );
    }
  }
  candidates.push(candidate);
  writeFileSync(file, `${JSON.stringify(candidates, null, 2)}\n`);
  return candidates.length;
}
