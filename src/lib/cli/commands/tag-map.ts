import { printJson, usageError } from "../../cli";
import {
  deletePathTagMapEntry,
  loadPathTagMap,
  pathTagMapFilePath,
  suggestTagsForPath,
  upsertPathTagMapEntry,
} from "../../path-tags";
import { parseTags } from "../shared";

function listTagMap() {
  const map = loadPathTagMap();
  printJson({
    file: pathTagMapFilePath(),
    mappings: Object.entries(map).map(([path_prefix, tags]) => ({
      path_prefix,
      tags,
    })),
  });
}

function setTagMap(
  pathPrefix: string | undefined,
  tagsRaw: string | undefined,
) {
  if (!pathPrefix || !tagsRaw) {
    usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
  }
  const tags = parseTags(tagsRaw);
  if (tags.length === 0) {
    usageError("Usage: tag-map set <path_prefix> <tag1,tag2,...>");
  }
  upsertPathTagMapEntry(pathPrefix, tags);
  printJson({
    status: "ok",
    path_prefix: pathPrefix,
    tags,
    file: pathTagMapFilePath(),
  });
}

function deleteTagMap(pathPrefix: string | undefined) {
  if (!pathPrefix) {
    usageError("Usage: tag-map delete <path_prefix>");
  }
  const current = loadPathTagMap();
  const existed = Object.hasOwn(current, pathPrefix);
  deletePathTagMapEntry(pathPrefix);
  printJson({
    status: existed ? "deleted" : "not_found",
    path_prefix: pathPrefix,
    file: pathTagMapFilePath(),
  });
}

function suggestTagMap(filePath: string | undefined) {
  if (!filePath) {
    usageError("Usage: tag-map suggest <path>");
  }
  const tags = suggestTagsForPath(filePath);
  printJson({ path: filePath, tags });
}

export function handleTagMapCommand(args: string[]) {
  const action = args[0];
  if (action === "list") {
    listTagMap();
    return;
  }
  if (action === "set") {
    setTagMap(args[1], args[2]);
    return;
  }
  if (action === "delete") {
    deleteTagMap(args[1]);
    return;
  }
  if (action === "suggest") {
    suggestTagMap(args[1]);
    return;
  }
  usageError("Usage: tag-map <list|set|delete|suggest> [args]");
}
