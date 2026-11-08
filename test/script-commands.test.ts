import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildScriptCommand, inspectScript, prepareScriptCommand, runScript } from '../src/engine/script-commands.ts';
import { encodeScriptArguments, validateScriptArguments } from '../src/shared/script-arguments.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, text: string, executable = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osb-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'user script with spaces.sh');
  await writeFile(path, text);
  await chmod(path, executable ? 0o755 : 0o644);
  return path;
}

test('selected script inspection reads public metadata and typed arguments without executing it', async (t) => {
  const path = await fixture(t, `#!/bin/sh

# @raycast.title Filter Notes
# @raycast.mode silent
# @raycast.description Filter notes by tag
# @raycast.icon 📝
# @raycast.packageName Notes
# @raycast.argument1 { "type": "text", "placeholder": "Tag", "percentEncoded": true }
# @raycast.argument2 { "type": "dropdown", "placeholder": "Scope", "data": [{ "title": "Pinned", "value": "pinned" }] }
# @raycast.argument3 { "type": "password", "placeholder": "Token", "optional": true }
printf 'this code is not metadata'
# @raycast.title This later comment is ignored
`);
  const meta = await inspectScript(path);
  assert.equal(meta.path, path);
  assert.equal(meta.title, 'Filter Notes');
  assert.equal(meta.description, 'Filter notes by tag');
  assert.equal(meta.icon, '📝');
  assert.equal(meta.packageName, 'Notes');
  assert.equal(meta.mode, 'silent');
  assert.deepEqual(meta.arguments, [
    { index: 1, type: 'text', placeholder: 'Tag', optional: false, percentEncoded: true },
    { index: 2, type: 'dropdown', placeholder: 'Scope', optional: false, percentEncoded: false, data: [{ title: 'Pinned', value: 'pinned' }] },
    { index: 3, type: 'password', placeholder: 'Token', optional: true, percentEncoded: false },
  ]);
  assert.match(meta.warnings.join(' '), /password.*interactively.*cannot store/);
});

test('inspection diagnoses malformed headers and keeps inline mode explicitly manual', async (t) => {
  const invalid = await fixture(t, '#!/bin/sh\n# @raycast.argument1 {bad json}\nprintf ok\n');
  await assert.rejects(inspectScript(invalid), /argument1 on line 2 has invalid JSON/);
  const empty = await fixture(t, '#!/bin/sh\n# @raycast.argument1\nprintf ok\n');
  await assert.rejects(inspectScript(empty), /argument1 on line 2 needs a value/);
  const duplicate = await fixture(t, '#!/bin/sh\n# @raycast.title A\n# @raycast.title B\n');
  await assert.rejects(inspectScript(duplicate), /Duplicate.*title.*line 3/);
  const gap = await fixture(t, '#!/bin/sh\n# @raycast.argument2 {"type":"text","placeholder":"Name"}\n');
  await assert.rejects(inspectScript(gap), /consecutive/);
  const dropdown = await fixture(t, '#!/bin/sh\n# @raycast.argument1 {"type":"dropdown","placeholder":"Pick"}\n');
  await assert.rejects(inspectScript(dropdown), /dropdown requires/);
  const inline = await fixture(t, '#!/bin/sh\n# @raycast.mode inline\nprintf ok\n');
  const meta = await inspectScript(inline);
  assert.equal(meta.mode, 'inline');
  assert.match(meta.warnings.join(' '), /only when pressed/);
});

test('inspection rejects binary/no-shebang files and bounds metadata reads', async (t) => {
  const plain = await fixture(t, 'printf ok\n');
  await assert.rejects(inspectScript(plain), /shebang/);
  const binary = await fixture(t, '#!/bin/sh\n\0binary');
  await assert.rejects(inspectScript(binary), /binary/);
  const giantHeader = await fixture(t, '#!/bin/sh\n' + '# comment\n'.repeat(7000));
  await assert.rejects(inspectScript(giantHeader), /header exceeds 64 KiB/);
  const giantBody = await fixture(t, '#!/bin/sh\nprintf ok\n' + '# body\n'.repeat(12000));
  assert.equal((await inspectScript(giantBody)).title, 'user script with spaces.sh');
});

test('command preparation validates selected paths and preserves argv without shell interpretation', async (t) => {
  const path = await fixture(t, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  const args = ['spaces and "quotes"', '$(printf injected); `printf injected`', ''];
  assert.deepEqual(await buildScriptCommand({ path, args }), { executable: path, args, cwd: dirname(path) });
  assert.deepEqual(await buildScriptCommand({ path }), { executable: path, args: [], cwd: dirname(path) });
  await assert.rejects(buildScriptCommand({ path: 'relative.sh' }), /absolute/);
  await assert.rejects(buildScriptCommand({ path: dirname(path) }), /not a directory/);
  await assert.rejects(buildScriptCommand({ path: path + '.missing' }), /not found/);
  await assert.rejects(buildScriptCommand({ path, args: ['a', 'b', 'c', 'd'] }), /at most three/);
  await assert.rejects(buildScriptCommand({ path, args: [5] as unknown as string[] }), /at most three/);
  await assert.rejects(buildScriptCommand({ path, args: new Array(1) }), /at most three/);
  await assert.rejects(buildScriptCommand({ path, args: null as unknown as string[] }), /at most three/);
  await assert.rejects(buildScriptCommand({ path, args: ['bad\0argument'] }), /null/);
  const notExecutable = await fixture(t, '#!/bin/sh\nprintf ok\n', false);
  await assert.rejects(buildScriptCommand({ path: notExecutable }), /executable/);
});

test('script execution keeps argv literal and uses the script directory', async (t) => {
  const path = await fixture(t, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n');
  const args = ['hello world', '$(printf injected); `printf injected`', '"quoted"'];
  const result = await runScript({ path, args });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, [await realpath(dirname(path)), ...args].join('\n') + '\n');
  assert.equal(result.stderr, '');
});

test('declared required arguments and dropdown choices are enforced during preparation and execution', async (t) => {
  const path = await fixture(t, `#!/bin/sh
# @raycast.argument1 {"type":"text","placeholder":"Project"}
# @raycast.argument2 {"type":"dropdown","placeholder":"Mode","data":[{"title":"Review","value":"review"},{"title":"Build","value":"build"}]}
# @raycast.argument3 {"type":"text","placeholder":"Optional note","optional":true}
printf "%s\\n" "$@"
`);
  await assert.rejects(buildScriptCommand({ path }), /Argument 1 \(Project\) is required/);
  await assert.rejects(buildScriptCommand({ path, args: [' ', 'review'] }), /Project.*required/);
  await assert.rejects(runScript({ path, args: ['project'] }), /Argument 2 \(Mode\) is required/);
  await assert.rejects(runScript({ path, args: ['project', 'arbitrary'] }), /Mode.*declared choices/);
  const metadata = await inspectScript(path);
  assert.deepEqual(validateScriptArguments(metadata.arguments, ['project', 'review']), []);
  assert.match(validateScriptArguments(metadata.arguments, ['project', 'not-allowed'])[0]!, /declared choices/);
  assert.deepEqual(await runScript({ path, args: ['project', 'review'] }), { code: 0, stdout: 'project\nreview\n', stderr: '' });
});

test('percentEncoded values are derived once from raw saved inputs and other arguments remain literal', async (t) => {
  const path = await fixture(t, `#!/bin/sh
# @raycast.argument1 {"type":"text","placeholder":"Query","percentEncoded":true}
# @raycast.argument2 {"type":"text","placeholder":"Literal"}
printf "%s\\n" "$@"
`);
  const raw = ['space + %20 / & unicode 雪', '$(printf injected); `printf injected` "quotes"'];
  const expected = [encodeURIComponent(raw[0]!), raw[1]!];
  const prepared = await prepareScriptCommand({ path, args: raw });
  assert.deepEqual(prepared.args, expected);
  assert.deepEqual(raw, ['space + %20 / & unicode 雪', '$(printf injected); `printf injected` "quotes"'], 'raw configuration remains unchanged');
  assert.deepEqual((await prepareScriptCommand({ path, args: raw })).args, expected, 'repeated preparation derives the same argv from raw settings');
  assert.deepEqual(encodeScriptArguments((await inspectScript(path)).arguments, raw), expected);
  assert.deepEqual(await runScript({ path, args: raw }), { code: 0, stdout: expected.join('\n') + '\n', stderr: '' });
});

test('password metadata stays inspectable but cannot be prepared or executed as a saved button', async (t) => {
  const path = await fixture(t, '#!/bin/sh\n# @raycast.argument1 {"type":"password","placeholder":"Token","optional":true}\nprintf "%s" "$1"\n');
  const metadata = await inspectScript(path);
  assert.equal(metadata.arguments[0]!.type, 'password');
  assert.match(metadata.warnings.join(' '), /Run it interactively/);
  assert.match(validateScriptArguments(metadata.arguments, [])[0]!, /saved buttons cannot store/);
  await assert.rejects(buildScriptCommand({ path }), /Run it interactively/);
  await assert.rejects(runScript({ path, args: ['fixture-value'] }), /Run it interactively/);
});

test('normal failed exits return status and output; launch and oversized-output failures reject cleanly', async (t) => {
  const failed = await fixture(t, '#!/bin/sh\nprintf "normal output"\nprintf "failure output" >&2\nexit 7\n');
  assert.deepEqual(await runScript({ path: failed }), { code: 7, stdout: 'normal output', stderr: 'failure output' });
  const unavailable = await fixture(t, '#!/definitely-missing-interpreter\nprintf ok\n');
  await assert.rejects(runScript({ path: unavailable }), /Could not launch script.*shebang interpreter/);
  const echo = await fixture(t, '#!/bin/sh\nprintf "%s" "$1"\n');
  await assert.rejects(runScript({ path: echo, args: ['x'.repeat(70_000)] }), /output exceeded the 64 KiB limit/);
});
