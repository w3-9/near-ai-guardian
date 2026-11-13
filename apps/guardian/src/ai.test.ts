import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, nearToYocto, type Proposal } from '@guardian/core';
import { decideProposal, type AiInput } from './ai';

afterEach(() => vi.unstubAllGlobals());

it('reuses an AI decision when only evidence collection times change', async () => {
  const proposal: Proposal = { id: 7, proposer: 'owner.testnet', description: '', kind: { Transfer: { token_id: '', receiver_id: 'target.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' };
  const input: AiInput = {
    daoId: 'wallet.sputnik-v2.testnet', proposal, policy: DEFAULT_POLICY, intent: null,
    intentComparison: { status: 'not_supplied', reason: 'No signed intent' }, ownerConfirmation: null, spentTodayYocto: '0',
    evidence: { accountId: 'target.testnet', accountExists: true, codeHash: null, allowlisted: false },
    history: {
      proposedAccountId: 'target.testnet',
      dao: { source: 'Sputnik DAO V2 on-chain proposals', queriedAt: '2026-10-25T10:00:00Z', sampledProposals: 0, totalProposalCount: 0, sampleCapped: false, executedNativeTransfers: 0, executedTransfersProposedLast24hInSample: 0, exactRecipientTransfers: 0, frequentRecipients: [], similarRecipients: [], recentExecutedTransfers: [] },
      proposedAccountActivity: { source: 'FastNEAR Testnet Transactions API', accountId: 'target.testnet', queriedAt: '2026-10-25T10:00:00Z', sampledTransactions: 0, moreTransactionsAvailable: false, observedLast24hInSample: 0, signerRows: 0, receiverRows: 0, oldestSampledAt: null, newestSampledAt: null, sampleTransactionHashes: [], hydratedTransactions: 0, detailBatchesFailed: 0, topCounterparties: [], actionTypes: [] },
    },
    impact: { type: 'unavailable', reason: 'Fixture' },
  };
  const config = { endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', apiKey: '' };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ daoId: input.daoId, proposalId: proposal.id, status: 'Rejected', reason: 'Target differs from prior recipients' }) } }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await decideProposal(config, input);
  await decideProposal(config, { ...input, history: { ...input.history, dao: { ...input.history.dao, queriedAt: '2026-10-25T10:00:15Z' }, proposedAccountActivity: { ...input.history.proposedAccountActivity, queriedAt: '2026-10-25T10:00:15Z' } } });
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockImplementationOnce(async () => {
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    return response;
  });
  await expect(decideProposal(config, input, true)).rejects.toThrow('AI provider did not complete its response within 60 seconds');
});
