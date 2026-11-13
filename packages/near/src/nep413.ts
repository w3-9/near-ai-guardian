import { verifyMessage } from 'near-api-js/nep413';
import type { JsonRpcProvider } from 'near-api-js';
import type { SignedIntentEnvelope } from '@guardian/core';

/** NEP-413 browser wallets may omit the optional callback URL from the signed payload. */
export async function verifyOwnerEnvelope(input: SignedIntentEnvelope, recipient: string, provider: JsonRpcProvider): Promise<void> {
  const common = {
    signerAccountId: input.accountId,
    signerPublicKey: input.publicKey,
    signature: Buffer.from(input.signature, 'base64'),
    provider,
  };
  const payload = { message: input.message, recipient, nonce: Buffer.from(input.nonce, 'base64') };
  try {
    await verifyMessage({ ...common, payload: { ...payload, callbackUrl: input.callbackUrl } });
  } catch (error) {
    if (!/Signature verification failed/.test(String(error))) throw error;
    await verifyMessage({ ...common, payload });
  }
}
