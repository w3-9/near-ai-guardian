import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPairEd25519 } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { makeTwoOfTwoPolicy, nearToYocto, type SignedIntentEnvelope } from '@guardian/core';
import { NearRpc } from '@guardian/near';

describe('Guardian first-time binding', () => {
  let folder = '';
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (folder) await rm(folder, { recursive: true, force: true }); });

  it('requires an Owner signature and on-chain 2-of-2 before permanently binding its generated key', async () => {
    folder = await mkdtemp(join(tmpdir(), 'guardian-bind-'));
    const identityFile = join(folder, 'identity.local');
    const guardianKey = KeyPairEd25519.fromRandom();
    const guardianId = Buffer.from(guardianKey.getPublicKey().data).toString('hex');
    const ownerKey = KeyPairEd25519.fromRandom();
    const ownerId = 'owner.testnet';
    const daoId = 'newdao.sputnik-v2.testnet';
    await writeFile(identityFile, `GUARDIAN_ACCOUNT_ID=${guardianId}\nGUARDIAN_PRIVATE_KEY=${guardianKey.toString()}\n`, { mode: 0o600 });
    vi.stubEnv('GUARDIAN_IDENTITY_FILE', identityFile);
    vi.stubEnv('GUARDIAN_DAO_ID', '');
    vi.stubEnv('GUARDIAN_OWNER_ID', '');
    vi.stubEnv('GUARDIAN_ACCOUNT_ID', guardianId);
    vi.stubEnv('GUARDIAN_PRIVATE_KEY', guardianKey.toString());
    vi.stubEnv('GUARDIAN_AI_ENDPOINT', '');
    vi.stubEnv('GUARDIAN_AI_MODEL', '');
    vi.spyOn(NearRpc.prototype, 'getPolicy').mockResolvedValue(makeTwoOfTwoPolicy(ownerId, guardianId));
    vi.spyOn(NearRpc.prototype, 'query').mockResolvedValue({ keys: [{ public_key: guardianKey.getPublicKey().toString() }] });
    vi.spyOn(NearRpc.prototype, 'balance').mockResolvedValue(nearToYocto('0.5'));
    vi.spyOn(JsonRpcProvider.prototype, 'viewAccessKey').mockResolvedValue({ permission: 'FullAccess', nonce: 1n, block_hash: 'fixture', block_height: 1 });
    const { bindGuardian } = await import('./cli');
    const message = JSON.stringify({ type: 'near-guardian-bind', version: 1, daoId, ownerId, guardianId, expiresAt: Date.now() + 300_000 });
    const nonce = new Uint8Array(32);
    const callbackUrl = 'http://127.0.0.1:5173/app';
    const signed = await signMessage({ signerAccount: new Account(ownerId, 'https://rpc.testnet.near.org', ownerKey.toString()), payload: { message, recipient: `near-guardian:${daoId}`, nonce, callbackUrl } });
    const envelope: SignedIntentEnvelope = { message, nonce: Buffer.from(nonce).toString('base64'), callbackUrl, accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64') };
    await expect(bindGuardian({ ...envelope, accountId: 'attacker.testnet' })).rejects.toThrow('Owner binding signature is invalid');
    expect(await readFile(identityFile, 'utf8')).not.toContain('GUARDIAN_DAO_ID');
    await expect(bindGuardian(envelope)).resolves.toMatchObject({ ok: true, daoId, ownerId, guardianId });
    const persisted = await readFile(identityFile, 'utf8');
    expect(persisted).toContain(`GUARDIAN_KEY_DAO_ID=${daoId}`);
    await expect(bindGuardian(envelope)).rejects.toThrow('already bound');
  });
});
