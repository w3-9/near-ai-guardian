import { isTestnetAccount, yoctoToNear, type Proposal } from '@guardian/core';
import { type NearRpc } from '@guardian/near';

const MAX_PROPOSALS = 100;
const MAX_ACCOUNT_TXS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const FASTNEAR_TESTNET_TX = 'https://tx.test.fastnear.com/v0/account';
const FASTNEAR_TESTNET_DETAILS = 'https://tx.test.fastnear.com/v0/transactions';

export type HistoricalTransfer = { proposalId: number; recipient: string; amountNear: string; proposedAt: string };
export type RecipientPattern = { accountId: string; executedTransfers: number; totalNear: string; lastProposedAt: string; editDistance?: number };
export type DaoHistory = {
  source: 'Sputnik DAO V2 on-chain proposals'; queriedAt: string; sampledProposals: number; totalProposalCount: number;
  sampleCapped: boolean; executedNativeTransfers: number; executedTransfersProposedLast24hInSample: number;
  exactRecipientTransfers: number; frequentRecipients: RecipientPattern[]; similarRecipients: RecipientPattern[];
  recentExecutedTransfers: HistoricalTransfer[];
};
export type AccountActivity = {
  source: 'FastNEAR Testnet Transactions API'; accountId: string; queriedAt: string; sampledTransactions: number;
  moreTransactionsAvailable: boolean; observedLast24hInSample: number; signerRows: number; receiverRows: number;
  oldestSampledAt: string | null; newestSampledAt: string | null; sampleTransactionHashes: string[];
  hydratedTransactions: number; detailBatchesFailed: number;
  topCounterparties: Array<{ accountId: string; observations: number }>;
  actionTypes: Array<{ type: string; observations: number }>;
};
export type HistoryEvidence = {
  proposedAccountId: string | null;
  dao: DaoHistory | { unavailable: string };
  proposedAccountActivity: AccountActivity | { unavailable: string };
};

function timestampMs(value: string): number | null {
  try {
    const number = Number(BigInt(value) / 1_000_000n);
    return Number.isFinite(number) && number > 0 ? number : null;
  } catch { return null; }
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length];
}

export async function daoHistory(rpc: NearRpc, daoId: string, proposedAccountId: string | null, now = Date.now()): Promise<DaoHistory> {
  const totalProposalCount = await rpc.getLastProposalId(daoId);
  if (!Number.isSafeInteger(totalProposalCount) || totalProposalCount < 0) throw new Error('DAO returned an invalid proposal count');
  const first = Math.max(0, totalProposalCount - MAX_PROPOSALS);
  const proposals: Proposal[] = [];
  for (let from = first; from < totalProposalCount; from += 50) {
    const page = await rpc.view<Proposal[]>(daoId, 'get_proposals', { from_index: from, limit: Math.min(50, totalProposalCount - from) });
    if (!Array.isArray(page)) throw new Error('DAO returned invalid proposal history');
    proposals.push(...page);
  }
  const transfers: Array<HistoricalTransfer & { amountYocto: bigint; timestamp: number }> = [];
  for (const proposal of proposals) {
    if (proposal.status !== 'Approved' || typeof proposal.kind !== 'object') continue;
    const transfer = proposal.kind.Transfer as { receiver_id?: string; token_id?: string; amount?: string } | undefined;
    if (!transfer || transfer.token_id !== '' || !transfer.receiver_id || !isTestnetAccount(transfer.receiver_id) || !transfer.amount || !/^\d+$/.test(transfer.amount)) continue;
    const timestamp = timestampMs(proposal.submission_time);
    if (timestamp === null) continue;
    transfers.push({ proposalId: proposal.id, recipient: transfer.receiver_id, amountNear: yoctoToNear(transfer.amount), amountYocto: BigInt(transfer.amount), proposedAt: new Date(timestamp).toISOString(), timestamp });
  }
  transfers.sort((a, b) => b.timestamp - a.timestamp);
  const patterns = new Map<string, { count: number; total: bigint; last: string }>();
  for (const transfer of transfers) {
    const current = patterns.get(transfer.recipient) || { count: 0, total: 0n, last: transfer.proposedAt };
    current.count++; current.total += transfer.amountYocto;
    patterns.set(transfer.recipient, current);
  }
  const recipients = [...patterns].map(([accountId, value]) => ({ accountId, executedTransfers: value.count, totalNear: yoctoToNear(value.total.toString()), lastProposedAt: value.last }));
  recipients.sort((a, b) => b.executedTransfers - a.executedTransfers || a.accountId.localeCompare(b.accountId));
  const similarRecipients = proposedAccountId ? recipients.flatMap(pattern => {
    const distance = editDistance(pattern.accountId, proposedAccountId);
    return distance > 0 && distance <= 2 ? [{ ...pattern, editDistance: distance }] : [];
  }).sort((a, b) => a.editDistance - b.editDistance || b.executedTransfers - a.executedTransfers).slice(0, 8) : [];
  return {
    source: 'Sputnik DAO V2 on-chain proposals', queriedAt: new Date(now).toISOString(), sampledProposals: proposals.length,
    totalProposalCount, sampleCapped: totalProposalCount > MAX_PROPOSALS, executedNativeTransfers: transfers.length,
    executedTransfersProposedLast24hInSample: transfers.filter(transfer => transfer.timestamp >= now - DAY_MS).length,
    exactRecipientTransfers: proposedAccountId ? patterns.get(proposedAccountId)?.count || 0 : 0,
    frequentRecipients: recipients.slice(0, 10), similarRecipients,
    recentExecutedTransfers: transfers.slice(0, 20).map(({ proposalId, recipient, amountNear, proposedAt }) => ({ proposalId, recipient, amountNear, proposedAt })),
  };
}

type AccountTxRow = { transaction_hash?: unknown; tx_block_timestamp?: unknown; is_real_signer?: unknown; is_signer?: unknown; is_real_receiver?: unknown; is_receiver?: unknown };
type AccountTxResponse = { account_txs?: unknown; resume_token?: unknown };
type HydratedTx = { transaction?: { signer_id?: string; receiver_id?: string; actions?: Array<Record<string, unknown> | string> }; receipts?: Array<{ receipt?: { predecessor_id?: string; receiver_id?: string; receipt?: { Action?: { actions?: Array<Record<string, unknown> | string> } } } }> };
const accountCache = new Map<string, { until: number; value: AccountActivity }>();

async function hydrateTransactions(hashes: string[], apiKey: string): Promise<{ transactions: HydratedTx[]; failedBatches: number }> {
  const batches: string[][] = [];
  for (let from = 0; from < hashes.length; from += 20) batches.push(hashes.slice(from, from + 20));
  const results = await Promise.allSettled(batches.map(async batch => {
    const response = await fetch(FASTNEAR_TESTNET_DETAILS, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ tx_hashes: batch }), signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Transaction details indexer HTTP ${response.status}`);
    const json = await response.json() as { transactions?: unknown };
    if (!Array.isArray(json.transactions)) throw new Error('Transaction details indexer returned an invalid response');
    return json.transactions as HydratedTx[];
  }));
  return { transactions: results.flatMap(result => result.status === 'fulfilled' ? result.value : []), failedBatches: results.filter(result => result.status === 'rejected').length };
}

function summarizeTransactions(accountId: string, transactions: HydratedTx[]) {
  const counterparties = new Map<string, number>();
  const actionTypes = new Map<string, number>();
  const addCounterparty = (value?: string) => { if (value && value !== accountId && value !== 'system' && isTestnetAccount(value)) counterparties.set(value, (counterparties.get(value) || 0) + 1); };
  const addActions = (actions?: Array<Record<string, unknown> | string>) => {
    for (const action of actions || []) {
      const types = typeof action === 'string' ? [action] : action && typeof action === 'object' ? Object.keys(action) : [];
      for (const type of types) actionTypes.set(type, (actionTypes.get(type) || 0) + 1);
    }
  };
  for (const item of transactions) {
    const tx = item.transaction;
    if (tx?.signer_id === accountId) addCounterparty(tx.receiver_id);
    if (tx?.receiver_id === accountId) addCounterparty(tx.signer_id);
    if (tx?.signer_id === accountId || tx?.receiver_id === accountId) addActions(tx.actions);
    for (const itemReceipt of item.receipts || []) {
      const receipt = itemReceipt.receipt;
      if (receipt?.predecessor_id === accountId) addCounterparty(receipt.receiver_id);
      if (receipt?.receiver_id === accountId) addCounterparty(receipt.predecessor_id);
      if (receipt?.predecessor_id === accountId || receipt?.receiver_id === accountId) addActions(receipt.receipt?.Action?.actions);
    }
  }
  return {
    topCounterparties: [...counterparties].map(([accountId, observations]) => ({ accountId, observations })).sort((a, b) => b.observations - a.observations).slice(0, 10),
    actionTypes: [...actionTypes].map(([type, observations]) => ({ type, observations })).sort((a, b) => b.observations - a.observations).slice(0, 10),
  };
}

export async function accountActivity(accountId: string, apiKey = '', now = Date.now()): Promise<AccountActivity> {
  if (!isTestnetAccount(accountId)) throw new Error('Only Testnet account activity is supported');
  const cached = accountCache.get(accountId);
  if (cached && cached.until > now) return cached.value;
  const response = await fetch(FASTNEAR_TESTNET_TX, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ account_id: accountId, desc: true, limit: MAX_ACCOUNT_TXS }), signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Account history indexer HTTP ${response.status}`);
  const json = await response.json() as AccountTxResponse;
  if (!Array.isArray(json.account_txs)) throw new Error('Account history indexer returned an invalid response');
  const rows = json.account_txs as AccountTxRow[];
  const timestamps = rows.map(row => typeof row.tx_block_timestamp === 'string' ? timestampMs(row.tx_block_timestamp) : null).filter((value): value is number => value !== null);
  const hashes = [...new Set(rows.flatMap(row => typeof row.transaction_hash === 'string' ? [row.transaction_hash] : []))];
  const details = await hydrateTransactions(hashes, apiKey);
  const behavior = summarizeTransactions(accountId, details.transactions);
  const value: AccountActivity = {
    source: 'FastNEAR Testnet Transactions API', accountId, queriedAt: new Date(now).toISOString(), sampledTransactions: rows.length,
    moreTransactionsAvailable: Boolean(json.resume_token), observedLast24hInSample: timestamps.filter(timestamp => timestamp >= now - DAY_MS).length,
    signerRows: rows.filter(row => row.is_real_signer === true || row.is_signer === true).length,
    receiverRows: rows.filter(row => row.is_real_receiver === true || row.is_receiver === true).length,
    oldestSampledAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    newestSampledAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    sampleTransactionHashes: hashes.slice(0, 8), hydratedTransactions: details.transactions.length, detailBatchesFailed: details.failedBatches,
    topCounterparties: behavior.topCounterparties, actionTypes: behavior.actionTypes,
  };
  accountCache.set(accountId, { until: now + 30_000, value });
  return value;
}

export async function collectHistory(rpc: NearRpc, daoId: string, proposal: Proposal, apiKey = '', now = Date.now()): Promise<HistoryEvidence> {
  const kind = typeof proposal.kind === 'object' ? proposal.kind : {};
  const proposedAccountId = (kind.Transfer as { receiver_id?: string } | undefined)?.receiver_id || (kind.FunctionCall as { receiver_id?: string } | undefined)?.receiver_id || null;
  const [daoResult, accountResult] = await Promise.allSettled([
    daoHistory(rpc, daoId, proposedAccountId, now),
    proposedAccountId ? accountActivity(proposedAccountId, apiKey, now) : Promise.resolve(null),
  ]);
  return {
    proposedAccountId,
    dao: daoResult.status === 'fulfilled' ? daoResult.value : { unavailable: String(daoResult.reason) },
    proposedAccountActivity: accountResult.status === 'fulfilled' && accountResult.value ? accountResult.value : { unavailable: accountResult.status === 'rejected' ? String(accountResult.reason) : 'This proposal has no account target' },
  };
}
