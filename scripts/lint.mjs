import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const roots = ['src', 'test', 'tests'];
const forbidden = [ /git\s+reset\s+--hard/i, /git\s+push\s+--force/i, /rm\s+-rf\s+\//i, /BEGIN\s+(?:RSA|OPENSSH|EC|PRIVATE)\s+KEY/i ];
async function files(directory) {
  try { const entries = await readdir(path.join(root, directory), { withFileTypes: true }); } catch { return []; }
  const result = [];
  const walk = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (/\.(?:ts|mjs|json)$/.test(entry.name)) result.push(file); } };
  await walk(path.join(root, directory));
  return result;
}
const all = (await Promise.all(roots.map(files))).flat();
const failures = [];
for (const file of all) { const content = await readFile(file, 'utf8'); for (const pattern of forbidden) if (pattern.test(content)) failures.push(`${path.relative(root, file)} matches ${pattern}`); }
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`lint passed for ${all.length} source files`);
