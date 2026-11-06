// User-selected executable scripts. Metadata inspection never executes the file.
// Public Raycast metadata is read independently; no upstream implementation is used.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { encodeScriptArguments, validateScriptArguments, type ScriptArgument } from '../shared/script-arguments.ts';
export type { ScriptArgument } from '../shared/script-arguments.ts';

const HEADER_BYTES = 64 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

export interface ScriptCommandOptions {
  path: string;
  args?: string[];
}

export type ScriptMode = 'silent' | 'compact' | 'fullOutput' | 'inline';

export interface ScriptCommandMetadata {
  path: string;
  title: string;
  description?: string;
  icon?: string;
  packageName?: string;
  mode: ScriptMode;
  arguments: ScriptArgument[];
  warnings: string[];
}

async function scriptPath(value: string): Promise<string> {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('Choose a script using an absolute path or a ~/ path.');
  }
  const expanded = value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error('Script path must be absolute or start with ~/.');
  const path = resolve(expanded);
  let info;
  try { info = await stat(path); } catch {
    throw new Error('Script was not found or cannot be read. Choose an existing script file.');
  }
  if (!info.isFile()) throw new Error('Script path must point to a file, not a directory.');
  try { await access(path, constants.R_OK | constants.X_OK); } catch {
    throw new Error('Script must be readable and executable. Check its file permissions.');
  }
  return path;
}

function argument(value: unknown, index: number, line: number): ScriptArgument {
  const fail = (reason: string): never => { throw new Error(`argument${index} on line ${line}: ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('metadata must be a JSON object.');
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'text' && obj.type !== 'password' && obj.type !== 'dropdown') {
    fail('type must be text, password, or dropdown.');
  }
  if (typeof obj.placeholder !== 'string' || !obj.placeholder.trim()) fail('a nonempty placeholder is required.');
  for (const field of ['optional', 'percentEncoded']) {
    if (obj[field] !== undefined && typeof obj[field] !== 'boolean') fail(`${field} must be true or false.`);
  }
  const result: ScriptArgument = {
    index,
    type: obj.type as ScriptArgument['type'],
    placeholder: obj.placeholder as string,
    optional: obj.optional === true,
    percentEncoded: obj.percentEncoded === true,
  };
  if (result.type === 'dropdown') {
    if (!Array.isArray(obj.data) || !obj.data.length) fail('dropdown requires a nonempty data list.');
    result.data = (obj.data as unknown[]).map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('each dropdown choice needs a title and value.');
      const choice = entry as Record<string, unknown>;
      if (typeof choice.title !== 'string' || typeof choice.value !== 'string') fail('dropdown titles and values must be strings.');
      return { title: choice.title as string, value: choice.value as string };
    });
  }
  return result;
}

export async function inspectScript(value: string): Promise<ScriptCommandMetadata> {
  const path = await scriptPath(value);
  const file = await open(path, 'r');
  let bytes: Buffer;
  let hasMore: boolean;
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
    hasMore = (await file.stat()).size > bytesRead;
  } finally {
    await file.close();
  }
  if (!bytes.subarray(0, 2).equals(Buffer.from('#!'))) {
    throw new Error('Choose a text script with a shebang on its first line, such as #!/bin/sh.');
  }
  if (bytes.includes(0)) throw new Error('The selected file contains binary data; choose a text script.');
  const text = bytes.toString('utf8');
  const metadata: ScriptCommandMetadata = { path, title: basename(path), mode: 'compact', arguments: [], warnings: [] };
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let headerEnded = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (!line.startsWith('#') && !line.startsWith('//')) {
      headerEnded = true;
      break;
    }
    if (hasMore && i === lines.length - 1) break; // Never parse a partially read directive.
    const directive = /^(?:#|\/\/)\s*@raycast\.(\S+)(?:\s+(.*))?$/.exec(line);
    if (!directive) continue;
    const [, field, raw] = directive;
    const content = (raw ?? '').trim();
    if (!content) throw new Error(`@raycast.${field} on line ${i + 1} needs a value.`);
    if (seen.has(field!)) throw new Error(`Duplicate @raycast.${field} metadata on line ${i + 1}.`);
    seen.add(field!);
    if (field === 'title' || field === 'description' || field === 'icon' || field === 'packageName') {
      metadata[field] = content;
    } else if (field === 'mode') {
      if (['silent', 'compact', 'fullOutput', 'inline'].includes(content)) metadata.mode = content as ScriptMode;
      else metadata.warnings.push(`Unknown mode ${JSON.stringify(content)}; using compact output.`);
    } else if (field?.startsWith('argument')) {
      if (!/^argument[1-3]$/.test(field)) throw new Error(`@raycast.${field} on line ${i + 1}: use argument1, argument2, or argument3.`);
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch {
        throw new Error(`@raycast.${field} on line ${i + 1} has invalid JSON. Use a JSON object with type and placeholder.`);
      }
      metadata.arguments.push(argument(parsed, Number(field.slice(-1)), i + 1));
    }
  }
  if (hasMore && !headerEnded) throw new Error('Script header exceeds 64 KiB. Put metadata near the beginning of the file.');
  metadata.arguments.sort((a, b) => a.index - b.index);
  if (metadata.arguments.some((arg, i) => arg.index !== i + 1)) {
    throw new Error('Script arguments must be consecutive, starting with argument1.');
  }
  if (metadata.arguments.some((arg, i, all) => !arg.optional && all.slice(0, i).some((a) => a.optional))) {
    throw new Error('Required script arguments must appear before optional arguments.');
  }
  if (metadata.mode === 'inline') metadata.warnings.push('Inline scripts run only when pressed here; automatic refresh is not enabled.');
  if (metadata.arguments.some((arg) => arg.type === 'password')) metadata.warnings.push('This script requests a password. Run it interactively; saved buttons cannot store or supply password arguments.');
  return metadata;
}

export async function buildScriptCommand(options: ScriptCommandOptions): Promise<{ executable: string; args: string[]; cwd: string }> {
  if (!options || typeof options !== 'object') throw new Error('Choose a script and provide its arguments.');
  const args = options.args === undefined ? [] : options.args;
  const errors = validateScriptArguments([], args);
  if (errors.length) throw new Error(errors[0]);
  const metadata = await inspectScript(options.path);
  return { executable: metadata.path, args: encodeScriptArguments(metadata.arguments, args), cwd: dirname(metadata.path) };
}

export async function prepareScriptCommand(options: ScriptCommandOptions): Promise<{ executable: string; args: string[]; cwd: string }> {
  return buildScriptCommand(options);
}

export async function runScript(options: ScriptCommandOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = await buildScriptCommand(options);
  return new Promise((resolve, reject) => {
    const child = execFile(command.executable, command.args, {
      cwd: command.cwd,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: OUTPUT_BYTES,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('Script output exceeded the 64 KiB limit. Reduce its output.'));
      if (error.killed) return reject(new Error('Script timed out after 30 seconds.'));
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
      if (error.signal) return reject(new Error(`Script ended unexpectedly (${error.signal}).`));
      reject(new Error(`Could not launch script (${error.code ?? 'unknown error'}). Check its shebang interpreter and file permissions.`));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}
