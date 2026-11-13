import { afterEach, describe, expect, it, vi } from 'vitest';
import { nearToYocto, type Proposal } from '@guardian/core';
import { type NearRpc } from '@guardian/near';
import { accountActivity, collectHistory, daoHistory } from './history';

const now = Date.parse('2026-10-25T12:00:00Z');
const timestamp = (when: number) => (BigInt(when) * 1_000_000n).toString();
const transfer = (id: number, recipient: string, status: string, when: number): Proposal => ({
  id, proposer: 'owner.testnet', description: 'Payout', kind: { Transfer: { token_id: '', receiver_id: recipient, amount: nearToYocto('0.5'), msg: null } }, status, votes: {}, submission_time: timestamp(when),
});

afterEach(() => vi.unstubAllGlobals());

describe('automatic transaction-history evidence', () => {
  it('finds a lookalike against previously executed DAO payouts and samples target activity', async () => {
    const proposals = [
      transfer(0, 'vendor.testnet', 'Approved', now - 2 * 60 * 60_000),
      transfer(1, 'vendor.testnet', 'Approved', now - 30 * 60_000),
      transfer(2, 'another.testnet', 'Approved', now - 3 * 24 * 60 * 60_000),
      transfer(3, 'vend0r.testnet', 'InProgress', now - 5 * 60_000),
    ];
    const rpc = { getLastProposalId: vi.fn(async () => 4), view: vi.fn(async () => proposals) } as unknown as NearRpc;
    const history = await daoHistory(rpc, 'multisig.sputnik-v2.testnet', 'vend0r.testnet', now);
    expect(history).toMatchObject({ sampledProposals: 4, executedNativeTransfers: 3, executedTransfersProposedLast24hInSample: 2, exactRecipientTransfers: 0 });
    expect(history.similarRecipients[0]).toMatchObject({ accountId: 'vendor.testnet', executedTransfers: 2, editDistance: 1 });
    expect(history.recentExecutedTransfers).toHaveLength(3);

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v0/transactions')) {
        expect(JSON.parse(String(init.body))).toEqual({ tx_hashes: ['new-hash', 'old-hash'] });
        return new Response(JSON.stringify({ transactions: [
          { transaction: { signer_id: 'vend0r.testnet', receiver_id: 'counterparty.testnet', actions: [{ Transfer: { deposit: '1' } }] }, receipts: [] },
          { transaction: { signer_id: 'other.testnet', receiver_id: 'vend0r.testnet', actions: ['CreateAccount', { FunctionCall: { method_name: 'pay' } }] }, receipts: [] },
        ] }), { status: 200 });
      }
      expect(JSON.parse(String(init.body))).toMatchObject({ account_id: 'vend0r.testnet', desc: true, limit: 100 });
      return new Response(JSON.stringify({ account_txs: [
        { transaction_hash: 'new-hash', tx_block_timestamp: timestamp(now - 60_000), is_real_receiver: true, is_real_signer: false },
        { transaction_hash: 'old-hash', tx_block_timestamp: timestamp(now - 3 * 24 * 60 * 60_000), is_real_receiver: false, is_real_signer: true },
      ], resume_token: 'more-pages', txs_count: 2 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const activity = await accountActivity('vend0r.testnet', '', now);
    expect(activity).toMatchObject({ sampledTransactions: 2, observedLast24hInSample: 1, receiverRows: 1, signerRows: 1, moreTransactionsAvailable: true, hydratedTransactions: 2, detailBatchesFailed: 0 });
    expect(activity.sampleTransactionHashes).toEqual(['new-hash', 'old-hash']);
    expect(activity.topCounterparties).toContainEqual({ accountId: 'counterparty.testnet', observations: 1 });
    expect(activity.actionTypes).toContainEqual({ type: 'Transfer', observations: 1 });
    expect(activity.actionTypes).toContainEqual({ type: 'CreateAccount', observations: 1 });
  });

  it('keeps on-chain DAO history when the account indexer is unavailable', async () => {
    const rpc = { getLastProposalId: vi.fn(async () => 0), view: vi.fn() } as unknown as NearRpc;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const evidence = await collectHistory(rpc, 'multisig.sputnik-v2.testnet', transfer(0, 'unavailable-target.testnet', 'InProgress', now), '', now);
    expect(evidence.dao).toMatchObject({ source: 'Sputnik DAO V2 on-chain proposals', sampledProposals: 0 });
    expect(evidence.proposedAccountActivity).toHaveProperty('unavailable');
  });

  it('marks missing transaction details instead of treating them as an empty behavior history', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/v0/account')
      ? new Response(JSON.stringify({ account_txs: [{ transaction_hash: 'missing-detail', tx_block_timestamp: timestamp(now), is_real_receiver: true }], resume_token: null, txs_count: 1 }), { status: 200 })
      : new Response('unavailable', { status: 503 })));
    const activity = await accountActivity('partial-history.testnet', '', now);
    expect(activity).toMatchObject({ sampledTransactions: 1, hydratedTransactions: 0, detailBatchesFailed: 1 });
    expect(activity.sampleTransactionHashes).toEqual(['missing-detail']);
  });
});
