// Shared by configuration forms and execution. Values supplied here are always raw saved inputs.
export interface ScriptArgument {
  index: number;
  type: 'text' | 'password' | 'dropdown';
  placeholder: string;
  optional: boolean;
  percentEncoded: boolean;
  data?: { title: string; value: string }[];
}

export function validateScriptArguments(specs: readonly ScriptArgument[], rawArgs: readonly string[]): string[] {
  if (!Array.isArray(rawArgs) || rawArgs.length > 3 || [...rawArgs].some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return ['Script arguments must be a list of at most three strings without null characters.'];
  }
  if (specs.some((arg) => arg.type === 'password')) {
    return ['This script requests a password. Run it interactively; saved buttons cannot store or supply password arguments.'];
  }
  const errors: string[] = [];
  for (const spec of specs) {
    const value = rawArgs[spec.index - 1] ?? '';
    const label = `Argument ${spec.index} (${spec.placeholder})`;
    if (!spec.optional && !value.trim()) errors.push(`${label} is required by the script.`);
    else if (spec.type === 'dropdown' && value !== '' && !spec.data?.some((choice) => choice.value === value)) {
      errors.push(`${label} must match one of the script's declared choices.`);
    }
  }
  return errors;
}

/** Encode once, immediately before process launch. Never persist this derived argv. */
export function encodeScriptArguments(specs: readonly ScriptArgument[], rawArgs: readonly string[]): string[] {
  const errors = validateScriptArguments(specs, rawArgs);
  if (errors.length) throw new Error(errors[0]);
  return rawArgs.map((value, index) => specs.find((arg) => arg.index === index + 1)?.percentEncoded ? encodeURIComponent(value) : value);
}
