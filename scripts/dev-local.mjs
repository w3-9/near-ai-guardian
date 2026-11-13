import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { ensureGuardianIdentity } from './guardian-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  writeFileSync(resolve(root, 'guardian-policy.json'), readFileSync(resolve(root, 'guardian-policy.example.json')), { mode: 0o600, flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') { console.error(`Could not initialize review policy: ${error.message}`); process.exit(1); }
}
let fileConfig;
try { fileConfig = parse(readFileSync(resolve(root, '.env'))); }
catch { console.error('Create a private .env from .env.example before starting the local demo.'); process.exit(1); }
let identityConfig;
try { identityConfig = ensureGuardianIdentity(resolve(root, '.guardian-identity.local')); }
catch (error) { console.error(`Guardian identity: ${error.message}`); process.exit(1); }
const config = { ...fileConfig, ...identityConfig, ...process.env };
const required = ['GUARDIAN_ACCOUNT_ID', 'GUARDIAN_PRIVATE_KEY', 'GUARDIAN_AI_ENDPOINT', 'GUARDIAN_AI_MODEL'];
const missing = required.filter(key => !config[key]?.trim());
if (missing.length) { console.error(`Set these values in .env before starting: ${missing.join(', ')}`); process.exit(1); }
if (config.PORT && config.PORT !== '8787') { console.error('The local demo requires PORT=8787.'); process.exit(1); }
if (config.GUARDIAN_WEB_ORIGIN && config.GUARDIAN_WEB_ORIGIN !== 'http://127.0.0.1:5173') { console.error('The local demo requires GUARDIAN_WEB_ORIGIN=http://127.0.0.1:5173.'); process.exit(1); }
if (config.GUARDIAN_CALLBACK_URL && config.GUARDIAN_CALLBACK_URL !== 'http://127.0.0.1:5173/app') { console.error('The local demo requires GUARDIAN_CALLBACK_URL=http://127.0.0.1:5173/app.'); process.exit(1); }

const webEnv = { ...process.env };
for (const key of Object.keys(webEnv)) if (key.startsWith('GUARDIAN_') || key.includes('PRIVATE_KEY') || key.includes('API_KEY')) delete webEnv[key];
const guardianEnv = { ...process.env, ...identityConfig };
const children = [
  spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: resolve(root, 'apps/web'), env: webEnv, stdio: 'inherit' }),
  spawn(process.execPath, ['--import', 'tsx', resolve(root, 'apps/guardian/src/cli.ts'), 'serve'], { cwd: root, env: guardianEnv, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
for (const child of children) {
  child.on('error', error => { console.error(`Local process failed: ${error.message}`); stop(1); });
  child.on('exit', (code, signal) => { if (!stopping) { console.error(`Local process exited (${signal || code}).`); stop(code || 1); } });
}
