import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { KeyPair } from 'near-api-js';

export function ensureGuardianIdentity(path) {
  const lock = `${path}.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Another Guardian identity setup is already running; check the local identity lock file'); }
  try {
    let values;
    try { values = parse(readFileSync(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; values = {}; }
    const daoId = values.GUARDIAN_DAO_ID?.trim() || '';
    const ownerId = values.GUARDIAN_OWNER_ID?.trim() || '';
    if (Boolean(daoId) !== Boolean(ownerId)) throw new Error('Guardian DAO and Owner must both be set or both be empty');
    if (daoId && !/^[a-z0-9_-]{2,32}\.sputnik-v2\.testnet$/.test(daoId)) throw new Error('Guardian DAO must be a Sputnik V2 Testnet account');
    if (ownerId && !/^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/.test(ownerId) && !/^[0-9a-f]{64}$/.test(ownerId)) throw new Error('Guardian Owner must be a Testnet account');
    if (values.GUARDIAN_KEY_DAO_ID && values.GUARDIAN_KEY_DAO_ID !== daoId) throw new Error('This Guardian key belongs to a different DAO. Use a separate self-hosted instance and key for each DAO.');

    let guardianId = values.GUARDIAN_ACCOUNT_ID?.trim() || '';
    let privateKey = values.GUARDIAN_PRIVATE_KEY?.trim() || '';
    if (Boolean(guardianId) !== Boolean(privateKey)) throw new Error('Guardian account and private key must both be present or both be empty');
    if (privateKey) {
      const publicKey = KeyPair.fromString(privateKey).getPublicKey();
      if (/^[0-9a-f]{64}$/.test(guardianId) && Buffer.from(publicKey.data).toString('hex') !== guardianId) throw new Error('Guardian private key does not match its implicit account ID');
    } else {
      const pair = KeyPair.fromRandom('ed25519');
      guardianId = Buffer.from(pair.getPublicKey().data).toString('hex');
      privateKey = pair.toString();
    }

    if (!values.GUARDIAN_ACCOUNT_ID || !values.GUARDIAN_PRIVATE_KEY || (daoId && !values.GUARDIAN_KEY_DAO_ID)) {
      const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      const body = `${daoId ? `GUARDIAN_DAO_ID=${daoId}\nGUARDIAN_OWNER_ID=${ownerId}\n` : ''}GUARDIAN_ACCOUNT_ID=${guardianId}\nGUARDIAN_PRIVATE_KEY=${privateKey}\n${daoId ? `GUARDIAN_KEY_DAO_ID=${daoId}\n` : ''}`;
      try {
        writeFileSync(temp, body, { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
      } catch (error) { try { unlinkSync(temp); } catch { /* no temporary file */ } throw error; }
    }
    chmodSync(path, 0o600);
    return { GUARDIAN_DAO_ID: daoId, GUARDIAN_OWNER_ID: ownerId, GUARDIAN_ACCOUNT_ID: guardianId, GUARDIAN_PRIVATE_KEY: privateKey };
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
