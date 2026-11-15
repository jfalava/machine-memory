export const ADD_USAGE =
  "add (<content> | --from-file <path>) [--upsert-match <query> | --update-id <id> | --create-new] [--allow-drop] [--upsert-threshold <score>] [--dry-run | --emit-candidate <file>] [--path <path|path,path,...>] [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--evidence <kinds>] [--validation-gaps <text|json_array>] [--source-agent <name>] [--refs <json_or_csv>] [--expires-after-days <n>] (--local|--remote) [--brief|--json-min|--quiet]";
export const UPDATE_USAGE =
  "update (<id|id,id,...> | --match <query>) [<content> | --from-file <path>] [--allow-drop] [--expected-update-count <n>] [--dry-run] [--tags <tags> | --add-tags <tags> --remove-tags <tags>] [--context <context> | --clear-context] [--type <memory_type>] [--certainty <certainty>] [--evidence <kinds|none>] [--validation-gaps <text|json_array|none> | --add-gap <text|json_array> --remove-gap <text|json_array>] [--updated-by <name>] [--refs <json_or_csv>] [--expires-after-days <n|null>] (--local|--remote) [--brief|--json-min|--quiet]";
export const DEPRECATE_USAGE =
  "deprecate (<id|id,id,...> | --match <query>) [--superseded-by <id>] [--updated-by <name>] (--local|--remote) [--brief|--json-min|--quiet]";

export const SIZE_USAGE =
  "size (<content> | --from-file <path>) [--tags <tags>] [--context <context>] [--local|--remote]";

export const REINDEX_USAGE =
  "reindex [--failed-only | --unindexed] [--id <id|id,id,...>] [--all-repos] --remote [--brief|--json-min|--quiet]";
export const INDEX_USAGE =
  "index status [--all-repos] --remote [--brief|--json-min|--quiet]";
