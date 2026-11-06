// Writes a separate, verified copy. The source data directory is read only.
import { recoverDataDir } from '../engine/data-recovery.ts';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Usage: npm run recover -- SOURCE_DATA_DIR NEW_DATA_DIR');
const result = recoverDataDir(sourceArg, outputArg);
console.log(`Recovered ${result.profiles} profiles with ${result.changes} changes.`);
console.log(`Start StreamDeckPlus with --data "${result.output}" to inspect the copy.`);
