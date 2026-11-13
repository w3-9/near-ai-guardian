import { describe, expect, it, vi } from 'vitest';
import { Account, JsonRpcProvider, KeyPairEd25519 } from 'near-api-js';
import { signMessage, verifyMessage } from 'near-api-js/nep413';

describe('NEP-413 owner intent', () => {
  it('verifies a full-access signature and rejects a changed receiver', async () => {
    const key = KeyPairEd25519.fromRandom();
    const account = new Account('alice.testnet', 'https://rpc.testnet.near.org', key.toString());
    const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
    vi.spyOn(provider, 'viewAccessKey').mockResolvedValue({ permission: 'FullAccess', nonce: 1n, block_hash: 'test', block_height: 1 });
    const payload = { message: JSON.stringify({ receiverId: 'trusted.testnet', amount: '100' }), recipient: 'near-guardian:demo.sputnik-v2.testnet', nonce: new Uint8Array(32), callbackUrl: 'http://127.0.0.1:5173/' };
    const signed = await signMessage({ signerAccount: account, payload });
    await expect(verifyMessage({ signerAccountId: signed.accountId, signerPublicKey: signed.publicKey, payload, signature: signed.signature, provider })).resolves.toBeUndefined();
    await expect(verifyMessage({ signerAccountId: signed.accountId, signerPublicKey: signed.publicKey, payload: { ...payload, message: JSON.stringify({ receiverId: 'attacker.testnet', amount: '100' }) }, signature: signed.signature, provider })).rejects.toThrow('Signature verification failed');
  });
});
