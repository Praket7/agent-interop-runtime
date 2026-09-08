import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const versionSource = fs.readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
const sourceVersion = versionSource.match(/VERSION\s*=\s*'([^']+)'/)?.[1];
const failures = [];
if (packageJson.mcpName !== serverJson.name) failures.push('package.json mcpName must match server.json name');
if (packageJson.version !== serverJson.version) failures.push('package.json version must match server.json version');
if (packageJson.version !== serverJson.packages?.[0]?.version) failures.push('server package version must match package.json version');
if (packageJson.version !== sourceVersion) failures.push('package.json version must match src/version.ts');
if (packageJson.name !== serverJson.packages?.[0]?.identifier) failures.push('server package identifier must match package.json name');
if (serverJson.packages?.[0]?.transport?.type !== 'stdio') failures.push('the published transport must be stdio');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`MCP metadata valid for ${packageJson.name}@${packageJson.version}`);
}
