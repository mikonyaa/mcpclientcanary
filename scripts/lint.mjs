import { readdir, readFile } from 'node:fs/promises';
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + entry.name;
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}
for (const file of await walk('src')) {
  const text = await readFile(file, 'utf8');
  if (/\bas any\b|\beval\s*\(|shell:\s*true|dangerously-skip-permissions/.test(text))
    throw Error(`Unsafe boundary in ${file}`);
}
console.log('Boundary lint passed. TypeScript unused-symbol lint is run separately.');
