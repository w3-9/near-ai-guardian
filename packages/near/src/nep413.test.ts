import { describe, expect, it, vi } from 'vitest';
import { Account, JsonRpcProvider, KeyPairEd25519 } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { verifyOwnerEnvelope } from './nep413';

describe('wallet message compatibility', () => {
  it('verifies NEP-413 signatures with or without a signed callback URL', async () => {
    const key = KeyPairEd25519.fromRandom();
    const account = new Account('owner.testnet', 'https://rpc.testnet.near.org', key.toString());
    const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
    vi.spyOn(provider, 'viewAccessKey').mockResolvedValue({ permission: 'FullAccess', nonce: 1n, block_hash: 'test', block_height: 1 });
    const nonce = Buffer.alloc(32, 7);
    const callbackUrl = 'http://127.0.0.1:5173/app';
    const recipient = 'near-guardian:dao.sputnik-v2.testnet';
    for (const walletIncludesCallback of [true, false]) {
      const message = JSON.stringify({ daoId: 'dao.sputnik-v2.testnet', policy: 'strict', walletIncludesCallback });
      const payload = { message, recipient, nonce, ...(walletIncludesCallback ? { callbackUrl } : {}) };
      const signed = await signMessage({ signerAccount: account, payload });
      const envelope = { message, nonce: nonce.toString('base64'), callbackUrl, accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64') };
      await expect(verifyOwnerEnvelope(envelope, recipient, provider)).resolves.toBeUndefined();
      await expect(verifyOwnerEnvelope({ ...envelope, message: 'changed' }, recipient, provider)).rejects.toThrow('Signature verification failed');
    }
  });
});
