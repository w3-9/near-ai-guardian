import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPairEd25519 } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { makeTwoOfTwoPolicy, nearToYocto, type Proposal, type SignedIntentEnvelope } from '@guardian/core';
import { NearRpc } from '@guardian/near';

const daoId = 'flow.sputnik-v2.testnet';
const ownerId = 'owner.testnet';
const guardianId = 'guardian.testnet';
const receiverId = 'trusted.testnet';
const callbackUrl = 'http://127.0.0.1:5173/';
const key = KeyPairEd25519.fromRandom();
const owner = new Account(ownerId, 'https://rpc.testnet.near.org', key.toString());
let folder = '';
let proposal: Proposal;
let flow: typeof import('./cli');
let send: ReturnType<typeof vi.spyOn>;
let aiFetch: ReturnType<typeof vi.spyOn>;

function indexerFixture() { return new Response(JSON.stringify({ account_txs: [], resume_token: null, txs_count: 0 }), { status: 200 }); }
function setModelResponse(body: string, status = 200) {
  aiFetch.mockImplementation(async (url: string | URL | Request) => String(url).includes('tx.test.fastnear.com') ? indexerFixture() : new Response(body, { status }));
}
async function defaultAiFixture(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (String(url).includes('tx.test.fastnear.com')) return indexerFixture();
  const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  const status = input.daoId === daoId && input.intentComparison?.status !== 'mismatch' ? 'Approved' : 'Rejected';
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: input.proposal.id, status, reason: status === 'Rejected' ? 'Owner intent does not match the on-chain action' : '提案符合当前标准' }) } }] }), { status: 200 });
}

async function envelope(message: string, signedCallbackUrl = callbackUrl, nonce = new Uint8Array(32)): Promise<SignedIntentEnvelope> {
  const signed = await signMessage({ signerAccount: owner, payload: { message, recipient: `near-guardian:${daoId}`, nonce, callbackUrl: signedCallbackUrl } });
  return { message, nonce: Buffer.from(nonce).toString('base64'), callbackUrl: signedCallbackUrl, accountId: signed.accountId, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64') };
}

describe('Guardian end-to-end service flow with testnet RPC fixtures', () => {
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'guardian-flow-'));
    vi.stubEnv('GUARDIAN_DAO_ID', daoId);
    vi.stubEnv('GUARDIAN_OWNER_ID', ownerId);
    vi.stubEnv('GUARDIAN_ACCOUNT_ID', guardianId);
    vi.stubEnv('GUARDIAN_PRIVATE_KEY', key.toString());
    vi.stubEnv('GUARDIAN_POLICY_FILE', join(folder, 'policy.json'));
    vi.stubEnv('GUARDIAN_INTENTS_FILE', join(folder, 'intents.json'));
    vi.stubEnv('GUARDIAN_CONFIRMATIONS_FILE', join(folder, 'confirmations.json'));
    vi.stubEnv('GUARDIAN_CALLBACK_URL', callbackUrl);
    proposal = { id: 0, proposer: ownerId, description: 'Pay contributor', kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' };
    await writeFile(join(folder, 'policy.json'), JSON.stringify({ mode: 'strict', allowedReceivers: [receiverId], allowedContracts: {}, maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true }));
    vi.spyOn(NearRpc.prototype, 'getPolicy').mockResolvedValue(makeTwoOfTwoPolicy(ownerId, guardianId));
    vi.spyOn(NearRpc.prototype, 'getProposal').mockImplementation(async () => proposal);
    vi.spyOn(NearRpc.prototype, 'getRecentProposals').mockImplementation(async () => [proposal]);
    vi.spyOn(NearRpc.prototype, 'getLastProposalId').mockResolvedValue(0);
    vi.spyOn(NearRpc.prototype, 'balance').mockResolvedValue(nearToYocto('10'));
    vi.spyOn(NearRpc.prototype, 'getAvailableAmount').mockResolvedValue(nearToYocto('8'));
    vi.spyOn(NearRpc.prototype, 'query').mockImplementation(async requestType => requestType === 'view_access_key_list'
      ? { keys: [{ public_key: key.getPublicKey().toString() }] } as never
      : { code_hash: '11111111111111111111111111111111' } as never);
    vi.spyOn(JsonRpcProvider.prototype, 'viewAccessKey').mockResolvedValue({ permission: 'FullAccess', nonce: 1n, block_hash: 'fixture', block_height: 1 });
    send = vi.spyOn(Account.prototype, 'signAndSendTransaction').mockResolvedValue({ transaction: { hash: 'fixture-hash' } } as never);
    aiFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultAiFixture);
    flow = await import('./cli');
    await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1/chat/completions', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
    await flow.testAiConnection();
  });

  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (folder) await rm(folder, { recursive: true, force: true }); });

  it('identifies a new implicit Guardian account before reading its empty access-key list', async () => {
    const query = vi.spyOn(NearRpc.prototype, 'query');
    const previous = query.getMockImplementation();
    query.mockClear();
    query.mockImplementation(async requestType => {
      if (requestType === 'view_account') throw new Error('account does not exist while viewing');
      if (requestType === 'view_access_key_list') return { keys: [] } as never;
      throw new Error(`Unexpected query: ${requestType}`);
    });
    try {
      await expect(flow.signerStatus(Buffer.alloc(32).toString('base64'))).resolves.toMatchObject({ accountExists: false, keyMatches: false });
      expect(query.mock.calls.some(call => call[0] === 'view_access_key_list')).toBe(false);
    } finally { query.mockImplementation(previous!); }
  });

  it('accepts an Owner-signed policy update and persists the effective policy', async () => {
    const policy = { mode: 'strict', allowedReceivers: [receiverId], allowedContracts: {}, maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true };
    const message = JSON.stringify({ type: 'near-guardian-policy', version: 1, daoId, policy, expiresAt: Date.now() + 300_000 });
    await expect(flow.savePolicy(await envelope(message))).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(folder, 'policy.json'), 'utf8'))).toEqual(policy);
  });

  it('does not vote if Guardian settings change while AI is reviewing', async () => {
    send.mockClear();
    await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
    await flow.testAiConnection();
    let changed = false;
    aiFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tx.test.fastnear.com')) return indexerFixture();
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (input.daoId === daoId && !changed) {
        changed = true;
        await flow.configure({ aiEndpoint: 'http://127.0.0.1:9998/v1', aiModel: 'fixture-model', aiApiKey: 'replacement-key' });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: input.proposal.id, status: 'Approved', reason: 'Fixture approval' }) } }] }), { status: 200 });
    });
    try {
      await expect(flow.approve(0)).rejects.toThrow('settings changed during review');
      expect(send).not.toHaveBeenCalled();
    } finally {
      aiFetch.mockImplementation(defaultAiFixture);
      await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
      await flow.testAiConnection();
    }
  });

  it('accepts signed messages when the browser clock is slightly ahead', async () => {
    const policy = { mode: 'strict', allowedReceivers: [receiverId], allowedContracts: {}, maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true };
    const expiresAt = Date.now() + 10 * 60_000 + 20_000;
    await expect(flow.savePolicy(await envelope(JSON.stringify({ type: 'near-guardian-policy', version: 1, daoId, policy, expiresAt })))).resolves.toMatchObject({ ok: true });
    const transfer = (proposal.kind as { Transfer: { receiver_id: string; token_id: string; amount: string } }).Transfer;
    await expect(flow.saveIntent(await envelope(JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId: transfer.receiver_id, tokenId: transfer.token_id, amount: transfer.amount, expiresAt })))).resolves.toMatchObject({ ok: true });
  });

  it('uses the default app callback URL when an old .env leaves it empty', async () => {
    vi.stubEnv('GUARDIAN_CALLBACK_URL', '');
    try {
      const policy = { mode: 'strict', allowedReceivers: [receiverId], allowedContracts: {}, maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true };
      const message = JSON.stringify({ type: 'near-guardian-policy', version: 1, daoId, policy, expiresAt: Date.now() + 300_000 });
      await expect(flow.savePolicy(await envelope(message, 'http://127.0.0.1:5173/app'))).resolves.toMatchObject({ ok: true });
    } finally { vi.stubEnv('GUARDIAN_CALLBACK_URL', callbackUrl); }
  });

  it('reviews and signs only the explicitly selected safe transfer', async () => {
    const transfer = (proposal.kind as { Transfer: { receiver_id: string; token_id: string; amount: string } }).Transfer;
    const message = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId: transfer.receiver_id, tokenId: transfer.token_id, amount: transfer.amount, expiresAt: Date.now() + 300_000 });
    await expect(flow.saveIntent(await envelope(message))).resolves.toEqual({ ok: true, proposalId: 0, matchesProposal: true });
    const modelRequests = () => aiFetch.mock.calls.filter((call: unknown[]) => String(call[0]).includes('127.0.0.1:9999')).length;
    const before = modelRequests();
    const result = await flow.reviewProposalAndVote(0);
    expect(result.decision.verdict).toBe('APPROVE');
    expect(result.guardianVoteTx).toBe('fixture-hash');
    expect(modelRequests() - before).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ receiverId: daoId });
  });

  it('withholds the vote when the second fresh AI review disagrees', async () => {
    send.mockClear();
    const originalFetch = aiFetch.getMockImplementation();
    let decisions = 0;
    aiFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tx.test.fastnear.com')) return indexerFixture();
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const status = input.daoId !== daoId || ++decisions === 1 ? 'Approved' : 'Rejected';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: input.proposal.id, status, reason: status === 'Approved' ? 'First check approved' : 'Second check rejected' }) } }] }), { status: 200 });
    });
    try {
      await expect(flow.approve(0)).rejects.toThrow('Second check rejected');
      expect(decisions).toBe(2);
      expect(send).not.toHaveBeenCalled();
    } finally { aiFetch.mockImplementation(originalFetch!); }
  });

  it('withholds the vote if balances change between two AI approvals', async () => {
    send.mockClear();
    const balance = vi.spyOn(NearRpc.prototype, 'balance');
    const original = balance.getMockImplementation();
    let reads = 0;
    balance.mockImplementation(async account => account === daoId ? nearToYocto(reads++ === 0 ? '10' : '9') : nearToYocto('2'));
    try {
      await expect(flow.approve(0)).rejects.toThrow('Review evidence or AI model changed');
      expect(reads).toBe(2);
      expect(send).not.toHaveBeenCalled();
    } finally { balance.mockImplementation(original!); }
  });

  it('blocks a changed receiver and never casts another vote', async () => {
    send.mockClear();
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: 'attacker.testnet', amount: nearToYocto('0.1'), msg: null } } };
    const reviewed = await flow.review(0);
    expect(reviewed.intentComparison.status).toBe('mismatch');
    expect(reviewed.aiDecision?.status).toBe('Rejected');
    expect(reviewed.decision.verdict).toBe('BLOCK');
    expect((await flow.reviewProposalAndVote(0)).decision.verdict).toBe('BLOCK');
    expect(send).not.toHaveBeenCalled();
  });
  it('passes a newly signed action mismatch to AI instead of rejecting the intent submission', async () => {
    const message = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await expect(flow.saveIntent(await envelope(message))).resolves.toEqual({ ok: true, proposalId: 0, matchesProposal: false });
    const reviewed = await flow.review(0);
    expect(reviewed.intent).toMatchObject({ receiverId });
    expect(reviewed.intentComparison.status).toBe('mismatch');
    expect(reviewed.aiDecision?.status).toBe('Rejected');
  });
  it('rejects a transfer when the Owner signed an intended contract call', async () => {
    send.mockClear();
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: 'test3.testnet', amount: nearToYocto('0.1'), msg: null } } };
    const expectedCall = { FunctionCall: { receiver_id: daoId, actions: [{ method_name: 'get_policy', args: 'e30=', deposit: '0', gas: '50000000000000' }] } };
    const message = JSON.stringify({ type: 'near-guardian-call', version: 1, daoId, proposalId: 0, proposer: ownerId, kind: expectedCall, expiresAt: Date.now() + 300_000 });
    await expect(flow.saveIntent(await envelope(message))).resolves.toEqual({ ok: true, proposalId: 0, matchesProposal: false });
    const reviewed = await flow.review(0);
    expect(reviewed.intentComparison).toMatchObject({ status: 'mismatch', reason: 'action type: Owner signed contract call; on-chain Transfer' });
    expect(reviewed.aiDecision?.status).toBe('Rejected');
    expect((await flow.reviewProposalAndVote(0)).decision.verdict).toBe('BLOCK');
    expect(send).not.toHaveBeenCalled();
  });

  it('passes a separately signed contract-call description to AI without requiring exact arguments', async () => {
    const call = { FunctionCall: { receiver_id: daoId, actions: [{ method_name: 'get_policy', args: 'e30=', deposit: '0', gas: '50000000000000' }] } };
    proposal = { ...proposal, kind: call };
    const text = `Read the current policy by calling get_policy on ${daoId}. No money or permissions should change.`;
    const message = JSON.stringify({ type: 'near-guardian-narrative', version: 1, daoId, proposalId: 0, proposer: ownerId, action: 'call', text, expiresAt: Date.now() + 300_000 });
    await expect(flow.saveIntent(await envelope(message))).resolves.toEqual({ ok: true, proposalId: 0, matchesProposal: null });
    const result = await flow.review(0);
    expect(result.intentComparison.status).toBe('semantic_review');
    expect(result.intent).toMatchObject({ action: 'call', text });
    const modelCall = [...aiFetch.mock.calls].reverse().find(call => String(call[0]).includes('127.0.0.1:9999'));
    const modelInput = JSON.parse(JSON.parse(String(modelCall?.[1]?.body)).messages[1].content);
    expect(modelInput.intent.text).toBe(text);
    expect(modelInput.proposal.kind).toEqual(call);
    const file = join(folder, 'intents.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored['0'].intent.text = 'Call a different method and move the funds.';
    await writeFile(file, JSON.stringify(stored));
    const tampered = await flow.review(0);
    expect(tampered.decision.verdict).toBe('BLOCK');
    expect(tampered.intent).toBeNull();
  });

  it('flags a signed contract-call description when the proposal is actually a transfer', async () => {
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: 'test3.testnet', amount: nearToYocto('0.1'), msg: null } } };
    const message = JSON.stringify({ type: 'near-guardian-narrative', version: 1, daoId, proposalId: 0, proposer: ownerId, action: 'call', text: `Call get_policy on ${daoId} to inspect the policy.`, expiresAt: Date.now() + 300_000 });
    await expect(flow.saveIntent(await envelope(message))).resolves.toMatchObject({ matchesProposal: false });
    const result = await flow.reviewProposalAndVote(0);
    expect(result.intentComparison.status).toBe('mismatch');
    expect(result.aiDecision?.status).toBe('Rejected');
    expect(send).not.toHaveBeenCalled();
  });

  it('compares the target contract, method, arguments and deposit against the signed call', async () => {
    const expectedCall = { FunctionCall: { receiver_id: daoId, actions: [{ method_name: 'get_policy', args: 'e30=', deposit: '0', gas: '50000000000000' }] } };
    const message = JSON.stringify({ type: 'near-guardian-call', version: 1, daoId, proposalId: 0, proposer: ownerId, kind: expectedCall, expiresAt: Date.now() + 300_000 });
    proposal = { ...proposal, kind: expectedCall };
    await expect(flow.saveIntent(await envelope(message))).resolves.toMatchObject({ matchesProposal: true });
    expect((await flow.review(0)).intentComparison.status).toBe('match');
    for (const [actual, expectedReason] of [
      [{ FunctionCall: { ...expectedCall.FunctionCall, receiver_id: 'other-contract.testnet' } }, 'contract:'],
      [{ FunctionCall: { ...expectedCall.FunctionCall, actions: [{ ...expectedCall.FunctionCall.actions[0], method_name: 'get_last_proposal_id' }] } }, 'method:'],
      [{ FunctionCall: { ...expectedCall.FunctionCall, actions: [{ ...expectedCall.FunctionCall.actions[0], args: 'eyJ4IjoxfQ==' }] } }, 'arguments differ'],
      [{ FunctionCall: { ...expectedCall.FunctionCall, actions: [{ ...expectedCall.FunctionCall.actions[0], deposit: nearToYocto('0.1') }] } }, 'attached deposit:'],
    ]) {
      proposal = { ...proposal, kind: actual };
      await expect(flow.saveIntent(await envelope(message))).resolves.toMatchObject({ matchesProposal: false });
      const reviewed = await flow.review(0);
      expect(reviewed.intentComparison.status).toBe('mismatch');
      expect(reviewed.intentComparison.reason).toContain(expectedReason);
      expect(reviewed.aiDecision?.status).toBe('Rejected');
    }
  });
  it('fails closed if the stored intent signature is altered', async () => {
    const path = join(folder, 'intents.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, { envelope: { signature: string } }>;
    stored['0'].envelope.signature = Buffer.alloc(64).toString('base64');
    await writeFile(path, JSON.stringify(stored));
    expect((await flow.review(0)).decision.reasons.some(reason => reason.includes('Signed intent verification failed'))).toBe(true);
  });
  it('fails closed if saved intent fields are changed while the signature stays valid', async () => {
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } } };
    const message = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await flow.saveIntent(await envelope(message));
    const path = join(folder, 'intents.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, { intent: { receiverId: string } }>;
    stored['0'].intent.receiverId = 'attacker.testnet';
    await writeFile(path, JSON.stringify(stored));
    const result = await flow.review(0);
    expect(result.decision.verdict).toBe('BLOCK');
    expect(result.decision.reasons.some(reason => reason.includes('Stored intent differs'))).toBe(true);
  });

  it('projects native transfer balance changes from RPC reads and refuses to label contract calls as simulated', async () => {
    const balance = vi.spyOn(NearRpc.prototype, 'balance').mockImplementation(async account => account === daoId ? nearToYocto('10') : nearToYocto('2'));
    const available = vi.spyOn(NearRpc.prototype, 'getAvailableAmount').mockResolvedValue(nearToYocto('8'));
    try {
      proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } } };
      const impact = await flow.previewImpact(0);
      expect(impact).toMatchObject({ type: 'balance-projection', executableFromAvailableBalance: true, accounts: [
        { accountId: daoId, beforeNear: '10', afterNear: '9.9', deltaNear: '-0.1' },
        { accountId: receiverId, beforeNear: '2', afterNear: '2.1', deltaNear: '+0.1' },
      ] });
      proposal = { ...proposal, kind: { FunctionCall: { receiver_id: 'contract.testnet', actions: [{ method_name: 'run', args: 'e30=', deposit: '0', gas: '50000000000000' }] } } };
      expect(await flow.previewImpact(0)).toMatchObject({ type: 'unavailable' });
    } finally { balance.mockRestore(); available.mockRestore(); }
  });

  it('lets AI reject a policy-allowed proposal and stops signing on API errors', async () => {
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } } };
    const message = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await flow.saveIntent(await envelope(message));
    const balance = vi.spyOn(NearRpc.prototype, 'balance').mockResolvedValue(nearToYocto('10'));
    const available = vi.spyOn(NearRpc.prototype, 'getAvailableAmount').mockResolvedValue(nearToYocto('8'));
    const query = vi.spyOn(NearRpc.prototype, 'query').mockImplementation(async requestType => requestType === 'view_access_key_list'
      ? { keys: [{ public_key: key.getPublicKey().toString() }] } as never
      : { code_hash: '11111111111111111111111111111111' } as never);
    setModelResponse(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId, proposalId: 0, status: 'Rejected', reason: '收款账户存在异常' }) } }] }));
    try {
      await flow.configure({ clearAi: true });
      await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1/chat/completions', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
      const blocked = await flow.review(0);
      expect(blocked.decision.verdict).toBe('BLOCK');
      expect(blocked.aiDecision?.status).toBe('Rejected');
      expect(JSON.parse(String(aiFetch.mock.lastCall?.[1]?.body)).messages[1].content).toContain('balance-projection');
      expect(aiFetch.mock.lastCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer fixture-key' });
      setModelResponse('unavailable', 503);
      await flow.configure({ clearAi: true });
      await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1/chat/completions', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
      const degraded = await flow.review(0);
      expect(degraded.decision.verdict).toBe('REVIEW');
      expect(degraded.aiError).toContain('503');
      setModelResponse(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId, proposalId: 99, status: 'Approved', reason: '错误的提案编号' }) } }] }));
      await flow.configure({ clearAi: true });
      await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1/chat/completions', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
      const mismatched = await flow.review(0);
      expect(mismatched.decision.verdict).toBe('REVIEW');
      expect(mismatched.aiError).toContain('another proposal');
    } finally { await flow.configure({ clearAi: true }); balance.mockRestore(); available.mockRestore(); query.mockRestore(); }
  });

  it('sends the strict policy and actual recipient to AI for its rejection reason', async () => {
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: 'other.testnet', amount: nearToYocto('0.1'), msg: null } } };
    const intent = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId: 'other.testnet', tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await flow.saveIntent(await envelope(intent));
    vi.spyOn(NearRpc.prototype, 'balance').mockResolvedValue(nearToYocto('10'));
    vi.spyOn(NearRpc.prototype, 'getAvailableAmount').mockResolvedValue(nearToYocto('8'));
    vi.spyOn(NearRpc.prototype, 'query').mockImplementation(async requestType => requestType === 'view_access_key_list'
      ? { keys: [{ public_key: key.getPublicKey().toString() }] } as never
      : { code_hash: '11111111111111111111111111111111' } as never);
    setModelResponse(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId, proposalId: 0, status: 'Rejected', reason: '收款地址不在 strict 白名单' }) } }] }));
    await flow.configure({ aiEndpoint: 'http://127.0.0.1:9997/v1', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
    const result = await flow.review(0);
    expect(result.aiDecision).toMatchObject({ status: 'Rejected', reason: '收款地址不在 strict 白名单' });
    expect(result.decision.verdict).toBe('BLOCK');
    const modelInput = JSON.parse(JSON.parse(String(aiFetch.mock.lastCall?.[1]?.body)).messages[1].content);
    expect(modelInput.policy).toMatchObject({ mode: 'strict', allowedReceivers: [receiverId] });
    expect(modelInput.proposal.kind.Transfer.receiver_id).toBe('other.testnet');
    expect(String(aiFetch.mock.lastCall?.[0])).toBe('http://127.0.0.1:9997/v1/chat/completions');
    await flow.configure({ clearAi: true });
  });

  it('waits for an Owner-signed confirmation, then asks AI again before voting', async () => {
    proposal = { ...proposal, kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } } };
    const intent = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await flow.saveIntent(await envelope(intent));
    vi.spyOn(NearRpc.prototype, 'balance').mockResolvedValue(nearToYocto('10'));
    vi.spyOn(NearRpc.prototype, 'getAvailableAmount').mockResolvedValue(nearToYocto('8'));
    vi.spyOn(NearRpc.prototype, 'query').mockImplementation(async requestType => requestType === 'view_access_key_list'
      ? { keys: [{ public_key: key.getPublicKey().toString() }] } as never
      : { code_hash: '11111111111111111111111111111111' } as never);
    aiFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tx.test.fastnear.com')) return indexerFixture();
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content);
      const status = input.ownerConfirmation ? 'Approved' : 'Needs user confirmation';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: input.proposal.id, status, reason: status === 'Approved' ? 'Owner 已确认当前转账' : '请 Owner 再次确认收款地址' }) } }] }), { status: 200 });
    });
    await flow.configure({ aiEndpoint: 'http://127.0.0.1:9998/v1/chat/completions', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
    await expect(flow.approve(0)).rejects.toThrow('请 Owner');
    send.mockClear();
    const waiting = await flow.review(0);
    expect(waiting.aiDecision?.status).toBe('Needs user confirmation');
    expect(waiting.decision.verdict).toBe('REVIEW');
    await expect(flow.approve(0)).rejects.toThrow('请 Owner');
    expect(send).not.toHaveBeenCalled();
    const confirmation = JSON.stringify({ type: 'near-guardian-confirmation', version: 1, daoId, proposalId: 0, proposalKind: proposal.kind, policyHash: waiting.policyHash, reason: 'I independently checked this payment', expiresAt: Date.now() + 300_000 });
    const modelCallsBeforeConfirmation = aiFetch.mock.calls.length;
    await expect(flow.saveConfirmation(await envelope(confirmation))).resolves.toEqual({ ok: true, proposalId: 0 });
    expect(aiFetch.mock.calls.length).toBe(modelCallsBeforeConfirmation);
    const accepted = await flow.review(0);
    expect(accepted.aiDecision?.status).toBe('Approved');
    expect(accepted.decision.verdict).toBe('APPROVE');
    await flow.approve(0);
    expect(send).toHaveBeenCalledOnce();
    await flow.configure({ clearAi: true });
  });

  it('passes repeated payouts to a near-identical address into AI and withholds the Guardian vote', async () => {
    send.mockClear();
    await writeFile(join(folder, 'intents.json'), '{}');
    const submitted = (hoursAgo: number) => (BigInt(Date.now() - hoursAgo * 60 * 60_000) * 1_000_000n).toString();
    const historical = [0, 1, 2].map(id => ({ id, proposer: ownerId, description: 'Previous payout', kind: { Transfer: { token_id: '', receiver_id: 'vendor.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'Approved', votes: {}, submission_time: submitted(id + 1) }));
    proposal = { id: 3, proposer: ownerId, description: 'Routine vendor payout', kind: { Transfer: { token_id: '', receiver_id: 'vend0r.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: submitted(0) };
    const lastId = vi.spyOn(NearRpc.prototype, 'getLastProposalId').mockResolvedValue(4);
    const view = vi.spyOn(NearRpc.prototype, 'view').mockResolvedValue([...historical, proposal] as never);
    aiFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tx.test.fastnear.com')) return indexerFixture();
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const similar = input.history?.dao?.similarRecipients?.some((item: { accountId: string; editDistance: number }) => item.accountId === 'vendor.testnet' && item.editDistance === 1);
      const status = input.daoId === daoId && similar ? 'Rejected' : input.daoId === daoId ? 'Approved' : 'Rejected';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: input.proposal.id, status, reason: similar ? 'Three prior payouts went to vendor.testnet, but this proposal targets vend0r.testnet' : 'Connection test' }) } }] }), { status: 200 });
    });
    try {
      await flow.configure({ clearAi: true });
      await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
      await flow.testAiConnection();
      const result = await flow.review(3);
      expect(result.history?.dao).toMatchObject({ exactRecipientTransfers: 0, similarRecipients: [{ accountId: 'vendor.testnet', executedTransfers: 3, editDistance: 1 }] });
      expect(result.aiDecision?.status).toBe('Rejected');
      expect((await flow.reviewProposalAndVote(3)).decision.verdict).toBe('BLOCK');
      expect(send).not.toHaveBeenCalled();
    } finally { await flow.configure({ clearAi: true }); lastId.mockRestore(); view.mockRestore(); }
  });

  it('lets AI review a proposal after its previous Owner intent expires', async () => {
    proposal = { id: 0, proposer: ownerId, description: 'Pay contributor', kind: { Transfer: { token_id: '', receiver_id: receiverId, amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' };
    const message = JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId: 0, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 });
    await flow.saveIntent(await envelope(message));
    const path = join(folder, 'intents.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, { expiresAt: number }>;
    stored['0'].expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(stored));
    vi.spyOn(NearRpc.prototype, 'getLastProposalId').mockResolvedValue(0);
    await flow.configure({ aiEndpoint: 'http://127.0.0.1:9999/v1', aiModel: 'fixture-model', aiApiKey: 'fixture-key' });
    const reviewed = await flow.review(0);
    expect(reviewed.intentComparison.status).toBe('not_supplied');
    expect(reviewed.decision.verdict).not.toBe('BLOCK');
    expect(reviewed.aiDecision).toBeTruthy();
    await flow.configure({ clearAi: true });
  });

  it('keeps concurrent signed intents without corrupting the JSON store', async () => {
    const signed = await Promise.all(Array.from({ length: 8 }, async (_, proposalId) => envelope(JSON.stringify({ type: 'near-guardian-transfer', version: 1, daoId, proposalId, proposer: ownerId, receiverId, tokenId: '', amount: nearToYocto('0.1'), expiresAt: Date.now() + 300_000 }))));
    await Promise.all(signed.map(input => flow.saveIntent(input)));
    const stored = JSON.parse(await readFile(join(folder, 'intents.json'), 'utf8')) as Record<string, unknown>;
    for (let id = 0; id < signed.length; id++) expect(stored[String(id)]).toBeTruthy();
  });

  it('reviews an older DAO by scanning recent proposals backwards', async () => {
    const submitted = (hoursAgo: number) => (BigInt(Date.now() - hoursAgo * 60 * 60_000) * 1_000_000n).toString();
    const old = { ...proposal, status: 'Approved' as const, submission_time: submitted(48) };
    const recent = { ...proposal, status: 'Approved' as const, submission_time: submitted(1) };
    vi.spyOn(NearRpc.prototype, 'getLastProposalId').mockResolvedValue(2100);
    const view = vi.spyOn(NearRpc.prototype, 'view').mockResolvedValue([old, recent] as never);
    const reviewed = await flow.review(0);
    expect(reviewed.spentTodayYocto).toBe(nearToYocto('0.1'));
    expect(view).toHaveBeenCalledWith(daoId, 'get_proposals', { from_index: 2050, limit: 50 });
  });
});
