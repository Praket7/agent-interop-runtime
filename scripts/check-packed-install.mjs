import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packDir = path.resolve(process.argv[2] ?? 'work');
const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const tarball = path.join(packDir, `${manifest.name}-${manifest.version}.tgz`);
if (!fs.existsSync(tarball)) throw new Error(`Packed npm tarball is missing: ${tarball}`);
const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-interop-pack-smoke-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  const install = spawnSync(npm, ['install', '--global', '--prefix', prefix, '--allow-scripts=node-pty', '--no-audit', '--no-fund', tarball], {
    stdio: 'inherit',
    env: { ...process.env },
    shell: process.platform === 'win32',
  });
  if (install.error) throw new Error(`Packed npm install could not start: ${install.error.message}`);
  if (install.status !== 0) throw new Error(`Packed npm install failed with exit code ${install.status ?? 'unknown'}`);

  const packageDir = path.join(prefix, 'lib', 'node_modules', 'agent-interop-runtime');
  const windowsPackageDir = path.join(prefix, 'node_modules', 'agent-interop-runtime');
  const installedDir = fs.existsSync(packageDir) ? packageDir : windowsPackageDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'));
  if (manifest.name !== 'agent-interop-runtime') throw new Error(`Unexpected package name: ${manifest.name}`);

  const cli = path.join(installedDir, 'dist', 'src', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`Packed CLI is missing: ${cli}`);
  const version = spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8' });
  if (version.error) throw new Error(`Installed CLI version command could not start: ${version.error.message}`);
  if (version.status !== 0) throw new Error(`Installed CLI version command failed: ${version.stderr || version.stdout}`);
  if (version.stdout.trim() !== manifest.version) throw new Error(`CLI version ${version.stdout.trim()} does not match package version ${manifest.version}`);

  console.log(`Packed npm install smoke test passed for agent-interop-runtime@${manifest.version}`);
} finally {
  fs.rmSync(prefix, { recursive: true, force: true });
}
