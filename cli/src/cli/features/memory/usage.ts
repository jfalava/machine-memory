export const ADD_USAGE =
  "add (<content> | --from-file <path>) [--upsert-match <query>] [--force] [--upsert-threshold <score>] [--dry-run] [--path <file_path>] [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--evidence <kinds>] [--validation-gaps <text|json_array>] [--source-agent <name>] [--refs <json_or_csv>] [--expires-after-days <n>] [--no-conflicts] [--token-report] (--local|--remote) [--brief|--json-min|--quiet]";
export const UPDATE_USAGE =
  "update (<id|id,id,...> | --match <query>) (<content> | --from-file <path>) [--dry-run] [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--evidence <kinds|none>] [--validation-gaps <text|json_array|none>] [--updated-by <name>] [--refs <json_or_csv>] [--expires-after-days <n|null>] [--token-report] (--local|--remote) [--brief|--json-min|--quiet]";
export const DEPRECATE_USAGE =
  "deprecate (<id|id,id,...> | --match <query>) [--superseded-by <id>] [--updated-by <name>] (--local|--remote) [--brief|--json-min|--quiet]";

export const SIZE_USAGE =
  "size (<content> | --from-file <path>) [--tags <tags>] [--context <context>] [--type <memory_type>] [--certainty <certainty>] [--local|--remote]";
