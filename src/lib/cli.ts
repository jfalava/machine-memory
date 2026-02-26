export function printJson(data: unknown) {
  console.info(JSON.stringify(data));
}

export function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function usageError(message: string): never {
  printJson({ error: message });
  process.exit(1);
}
