import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InjectedWallet, WalletSelector } from '@near-wallet-selector/core';
import { Buffer } from 'buffer';
import { DEFAULT_POLICY, isTestnetAccount, nearToYocto, sameProposalKind, validateGuardianPolicy, verifyTwoOfTwo, yoctoToNear, type GuardianPolicy, type Proposal, type ProposalIntent, type SignedIntentEnvelope, type SputnikPolicy } from '@guardian/core';
import { addCouncilMemberProposal, createDaoArgs, daoIdFromName, DEFAULT_RPC, FACTORY_ID, functionCallProposal, isSputnikDaoId, NearRpc, transferProposal } from '@guardian/near';
import { GuardianMark, LandingPage } from './Landing';
import { AddressComparison } from './AddressComparison';
import { DEMO_DAO, DEMO_PROPOSAL, DEMO_PROPOSAL_ID, DemoPage } from './Demo';
import './style.css';

// Meteor Wallet's transaction approval flow uses the Node Buffer global in the browser.
function ensureWalletBuffer() { globalThis.Buffer ??= Buffer; }
ensureWalletBuffer();

const PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === '1';

type Treasury = { daoId: string; ownerId: string; guardianId: string };
function treasuryKey(value: Treasury | null): string { return value ? `${value.daoId}|${value.ownerId}|${value.guardianId}` : ''; }
type AiDecision = { status: 'Approved' | 'Rejected' | 'Needs user confirmation'; reason: string; model: string };
type HistoryReviewEvidence = { proposedAccountId: string | null; dao: { unavailable: string } | { sampledProposals: number; totalProposalCount: number; exactRecipientTransfers: number; similarRecipients: Array<{ accountId: string; executedTransfers: number; editDistance?: number }> }; proposedAccountActivity: { unavailable: string } | { sampledTransactions: number; observedLast24hInSample: number; moreTransactionsAvailable: boolean; hydratedTransactions: number; detailBatchesFailed: number; sampleTransactionHashes: string[]; topCounterparties: Array<{ accountId: string; observations: number }>; actionTypes: Array<{ type: string; observations: number }> } };
type Review = { decision: { verdict: string; reasons: string[]; facts: string[] }; spentTodayNear: string; policyHash: string; intent?: ProposalIntent | null; intentComparison?: { status: 'match' | 'mismatch' | 'semantic_review' | 'not_supplied'; reason: string }; history?: HistoryReviewEvidence | null; reviewedAt?: string; guardianVoteTx?: string | null; aiDecision?: AiDecision | null; aiError?: string | null };
type ReviewSummary = { proposalId: number; status: AiDecision['status'] | 'Blocked' | 'Unavailable'; reason: string; reviewedAt: string; policyHash: string; intentVerified: boolean; intentMatches?: boolean | null; history?: HistoryReviewEvidence | null; model?: string; guardianVoteTx?: string | null };
type GuardianStatus = { daoId: string; ownerId: string; guardianId: string; policy: GuardianPolicy; council: { ok: boolean; reasons: string[] }; signer?: { ready: boolean; reason: string; balanceNear?: string }; ai?: { configured: boolean; ready: boolean; model: string }; reviews?: ReviewSummary[] };
type PendingSignature = { kind: 'bind' | 'intent' | 'policy' | 'confirmation'; message: string; nonce: string; callbackUrl: string; state: string; returnPath?: string };
function guardianFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(240_000) });
}
type TxAction = ReturnType<typeof import('@near-wallet-selector/core').actionCreators.functionCall> | ReturnType<typeof import('@near-wallet-selector/core').actionCreators.transfer>;
type IntentDraft = { action: 'transfer' | 'call'; receiverId: string; amountNear: string; text: string };
type Impact = { type: 'balance-projection' | 'unavailable'; reason?: string; amountNear?: string; executableFromAvailableBalance?: boolean; accounts?: Array<{ accountId: string; beforeNear: string | null; afterNear: string | null; deltaNear: string }>; note?: string };
type View = 'overview' | 'proposals' | 'new' | 'policy' | 'treasury';
type WalletChoice = 'meteor-wallet' | 'nightly';
const WALLET_NAMES: Record<WalletChoice, string> = { 'meteor-wallet': 'Meteor Wallet', nightly: 'Nightly Wallet' };
const TREASURY_STORAGE = 'guardian-treasury-v2';
const PENDING_TREASURY_STORAGE = 'guardian-pending-treasury-v2';
const POLICY_STORAGE = 'guardian-policy-v2';
const NAV: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'new', label: 'New proposal' },
  { id: 'policy', label: 'Review policy' },
  { id: 'treasury', label: 'Multisig' },
];
const EMPTY_INTENT_DRAFT: IntentDraft = { action: 'transfer', receiverId: '', amountNear: '', text: '' };
const CREATE_RETRIES = 20;
async function nearActionCreators() { return (await import('@near-wallet-selector/core')).actionCreators; }

function workspaceRoute(demoMode: boolean): { view: View; proposalId: number | null } {
  const base = demoMode ? '/app/demo' : '/app';
  const parts = window.location.pathname.slice(base.length).split('/').filter(Boolean);
  if (parts[0] === 'proposals') return { view: 'proposals', proposalId: parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null };
  if (!demoMode && NAV.some(item => item.id === parts[0])) return { view: parts[0] as View, proposalId: null };
  return demoMode ? { view: 'proposals', proposalId: DEMO_PROPOSAL_ID } : { view: 'overview', proposalId: null };
}

function workspacePath(view: View, proposalId: number | null, demoMode: boolean): string {
  const base = demoMode ? '/app/demo' : '/app';
  return view === 'overview' ? `${base}/overview` : view === 'proposals' && proposalId !== null ? `${base}/proposals/${proposalId}` : `${base}/${view}`;
}

function NavIcon({ view }: { view: View }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (view) {
    case 'overview': return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M10 10v10"/></svg>;
    case 'proposals': return <svg {...common}><path d="M7 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9 8h7M9 12h7M9 16h4"/></svg>;
    case 'new': return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>;
    case 'policy': return <svg {...common}><rect x="5" y="3" width="14" height="18" rx="2"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>;
    case 'treasury': return <svg {...common}><path d="M4 7V6a2 2 0 0 1 2-2h12M5 7h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M21 12h-6a2 2 0 0 0 0 4h6m-6-2h.01"/></svg>;
  }
}

function ProposalIcon({ proposal }: { proposal: Proposal }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (kindName(proposal)) {
    case 'Transfer': return <svg {...common}><path d="M4 12h15m-6-6 6 6-6 6"/></svg>;
    case 'FunctionCall': return <svg {...common}><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-6 3 4-16"/></svg>;
    case 'AddMemberToRole': return <svg {...common}><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0m4-9v8m-4-4h8"/></svg>;
    default: return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>;
  }
}

async function waitForCreatedTreasury(next: Treasury, rpc: NearRpc): Promise<void> {
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt++) {
    let onchain: SputnikPolicy;
    try {
      onchain = await rpc.getPolicy(next.daoId);
    } catch (error) {
      if (attempt === CREATE_RETRIES - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    const council = verifyTwoOfTwo(onchain, next.ownerId, next.guardianId);
    if (!council.ok) throw new Error(`The on-chain multisig members do not match the entered accounts: ${council.reasons.join('; ')}`);
    return;
  }
}

function savedTreasury(): Treasury | null {
  try {
    localStorage.removeItem("guardian-treasury");
    localStorage.removeItem("guardian-pending-treasury");
    localStorage.removeItem("guardian-policy");
    return JSON.parse(localStorage.getItem(TREASURY_STORAGE) || 'null') as Treasury | null;
  } catch { return null; }
}

function savedPolicy(): GuardianPolicy {
  try { return { ...DEFAULT_POLICY, ...JSON.parse(localStorage.getItem(POLICY_STORAGE) || '{}') }; } catch { return DEFAULT_POLICY; }
}

function receiversFromText(value: string): string[] { return value.split('\n').map(line => line.trim()).filter(Boolean); }
function contractsFromText(value: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const [contract, method, extra] = line.trim().split(':');
    if (extra || !isTestnetAccount(contract) || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(method || '')) throw new Error(`Invalid contract allowlist entry: ${line}`);
    (map[contract] ||= []).push(method);
  }
  return map;
}

function kindName(proposal: Proposal) { return typeof proposal.kind === 'string' ? proposal.kind : Object.keys(proposal.kind)[0] || 'Unknown'; }
function isNativeNearTransfer(proposal: Proposal): boolean {
  if (typeof proposal.kind !== 'object') return false;
  const transfer = proposal.kind.Transfer as { token_id?: string } | undefined;
  return transfer?.token_id === '';
}
function kindLabel(proposal: Proposal) { return ({ Transfer: 'Transfer', FunctionCall: 'Contract call', AddMemberToRole: 'Member change' } as Record<string, string>)[kindName(proposal)] || kindName(proposal); }
function proposalStatusLabel(status: string) { return ({ InProgress: 'Pending', Approved: 'Approved · executed', Rejected: 'Rejected', Removed: 'Removed', Expired: 'Expired', Failed: 'Execution failed' } as Record<string, string>)[status] || status; }
function proposalStatusStyle(status: string) { return status === 'InProgress' ? 'pending' : status === 'Approved' ? 'done' : 'blocked'; }
function voteLabel(vote?: string) { return vote === 'VoteApprove' ? 'Approved' : vote === 'VoteReject' ? 'Rejected' : vote === 'VoteRemove' ? 'Removed' : vote ? vote : 'Pending'; }
function sameVotes(left: Proposal['votes'], right: Proposal['votes']): boolean {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  return leftKeys.length === rightKeys.length && leftKeys.every(account => left[account] === right[account]);
}
function aiStatusLabel(status: AiDecision['status']) { return status; }
function proposalSummary(proposal: Proposal): string {
  if (typeof proposal.kind !== 'object') return String(proposal.kind);
  const transfer = proposal.kind.Transfer as { receiver_id?: string; amount?: string } | undefined;
  if (transfer) {
    try { return `Send ${yoctoToNear(transfer.amount || '0')} NEAR to ${transfer.receiver_id}`; }
    catch { return `Send ${transfer.amount} yoctoNEAR to ${transfer.receiver_id}`; }
  }
  const call = proposal.kind.FunctionCall as { receiver_id?: string; actions?: Array<{ method_name?: string }> } | undefined;
  if (call) return `Call ${call.receiver_id}.${call.actions?.map(action => action.method_name).join(', ') || '?'}`;
  return kindLabel(proposal);
}

function guardianVerdict(proposal: Proposal, guardianId: string, review?: Review, history?: ReviewSummary, demoMode = false): { label: string; tone: string } {
  if (demoMode && proposal.id === DEMO_PROPOSAL_ID) return { label: 'Example review: Rejected', tone: 'blocked' };
  const status = review?.aiDecision?.status || history?.status;
  if (status === 'Approved') return { label: 'AI: Approved', tone: 'done' };
  if (status === 'Rejected') return { label: 'AI: Rejected', tone: 'blocked' };
  if (status === 'Blocked') return { label: 'Blocked', tone: 'blocked' };
  if (status === 'Needs user confirmation') return { label: 'AI: Confirm first', tone: 'pending' };
  if (proposal.votes?.[guardianId]) return { label: 'Guardian voted', tone: 'done' };
  return { label: 'Awaiting review', tone: 'neutral' };
}

function ProposalRow({ proposal, guardianId, review, history, demoMode, onOpen, showStatus = false }: {
  proposal: Proposal; guardianId: string; review?: Review; history?: ReviewSummary; demoMode: boolean; onOpen: () => void; showStatus?: boolean;
}) {
  const verdict = guardianVerdict(proposal, guardianId, review, history, demoMode);
  return <button className={`transaction-row ${showStatus ? 'queue-row' : ''}`} onClick={onOpen}>
    <span className="transaction-name"><span className="proposal-symbol"><ProposalIcon proposal={proposal}/></span><span><b>{proposalSummary(proposal)}</b><small>Proposal #{proposal.id} · {kindLabel(proposal)}</small></span></span>
    <span className="transaction-summary"><small>Unverified note</small>{proposal.description || 'No description'}</span>
    <span className={`guardian-verdict ${verdict.tone}`}>{verdict.label}</span>
    <span className="transaction-signatures">{Object.keys(proposal.votes || {}).length} / 2</span>
    {showStatus && <span className={`status-pill ${proposalStatusStyle(proposal.status)}`}>{demoMode ? 'Example' : proposalStatusLabel(proposal.status)}</span>}
    <span className="transaction-arrow">↗</span>
  </button>;
}

function IntentDraftEvidence({ proposal, draft }: { proposal: Proposal; draft: IntentDraft }) {
  const transfer = typeof proposal.kind === 'object' ? proposal.kind.Transfer as { receiver_id?: string; amount?: string } | undefined : undefined;
  if (draft.action === 'call' && transfer) return <div className="intent-draft-comparison"><span>Draft comparison</span><p className="differs">Action type differs: your intent describes a contract call; the on-chain proposal transfers NEAR.</p><small>Guardian will verify your signed intent and send this mismatch to the model.</small></div>;
  if (draft.action === 'call') return null;
  if (draft.action === 'transfer' && typeof proposal.kind === 'object' && proposal.kind.FunctionCall) return <div className="intent-draft-comparison"><span>Draft comparison</span><p className="differs">Action type differs: your intent is a transfer; the on-chain proposal calls a contract.</p><small>Guardian will verify your signed intent and send this mismatch to the model.</small></div>;
  if (!transfer?.receiver_id || !draft.receiverId.trim()) return null;
  const onchainAmount = transfer.amount ? yoctoToNear(transfer.amount) : '?';
  let amountMatches = false;
  try { amountMatches = draft.amountNear !== '' && nearToYocto(draft.amountNear) === transfer.amount; } catch { /* A malformed draft cannot match. */ }
  return <div className="intent-draft-comparison"><span>Draft comparison</span><AddressComparison expected={draft.receiverId.trim()} actual={transfer.receiver_id}/><p className={amountMatches ? 'matches' : 'differs'}>Amount: your draft {draft.amountNear || '—'} NEAR · on-chain {onchainAmount} NEAR {draft.amountNear ? amountMatches ? '✓' : '· does not match' : ''}</p><small>This comparison is local. Once signed, Guardian verifies your intent and includes any mismatch in the review.</small></div>;
}

function ReviewEvidence({ review, history, proposal, guardianId }: { review?: Review; history?: ReviewSummary; proposal: Proposal; guardianId: string }) {
  if (!review && !history) return null;
  const intent = review?.intent;
  const verified = intent ? true : history?.intentVerified ?? false;
  const intentMatches = review?.intentComparison?.status === 'mismatch' ? false : review?.intentComparison?.status === 'match' ? true : history?.intentMatches;
  const timestamp = review?.reviewedAt || history?.reviewedAt;
  const voteTx = review?.guardianVoteTx || history?.guardianVoteTx;
  const transfer = typeof proposal.kind === 'object' ? proposal.kind.Transfer as { receiver_id?: string } | undefined : undefined;
  const signedReceiver = intent && 'receiverId' in intent ? intent.receiverId : null;
  const historical = review?.history || history?.history;
  return <div className="review-evidence"><h3>Review evidence</h3><dl>
    <div><dt>Model</dt><dd>{review?.aiDecision?.model || history?.model || 'No model decision'}</dd></div>
    <div><dt>Reviewed</dt><dd>{timestamp ? new Date(timestamp).toLocaleString() : 'Not recorded'}</dd></div>
    <div><dt>Owner-signed intent</dt><dd>{verified ? intentMatches === false ? 'Signature verified · action mismatch' : intent && 'text' in intent ? 'Signature verified · interpreted by AI' : intentMatches === true ? 'Signature verified · action matches' : 'Signature verified · match not recorded' : 'Not supplied'}</dd></div>
    <div><dt>Policy hash</dt><dd><code>{review?.policyHash || history?.policyHash || '—'}</code></dd></div>
    <div><dt>Guardian vote</dt><dd>{voteTx ? <a href={`https://testnet.nearblocks.io/txns/${voteTx}`} target="_blank" rel="noreferrer">View transaction ↗</a> : proposal.votes?.[guardianId] ? 'Present on-chain · tx not recorded in this session' : 'No vote on-chain'}</dd></div>
  </dl>
    {review?.intentComparison?.status === 'mismatch' && <p className="intent-mismatch-reason">{review.intentComparison.reason}</p>}
    {intent && 'text' in intent && <div className="signed-intent-text"><span>Owner-signed description</span><p>{intent.text}</p></div>}
    {review?.intentComparison?.status === 'not_supplied' && review.intentComparison.reason !== 'No Owner-signed intent was supplied' && <p className="intent-mismatch-reason">{review.intentComparison.reason}</p>}
    {signedReceiver && transfer?.receiver_id && <AddressComparison expected={signedReceiver} actual={transfer.receiver_id} expectedLabel="Owner-signed recipient"/>}
    {historical && <div className="history-evidence"><h4>History checked for this decision</h4>
      {'unavailable' in historical.dao
        ? <p>DAO payout history unavailable: {historical.dao.unavailable}</p>
        : <><p>Sampled {historical.dao.sampledProposals} of {historical.dao.totalProposalCount} on-chain proposals. This recipient appeared in {historical.dao.exactRecipientTransfers} executed native transfers.</p>
          {historical.dao.similarRecipients.length > 0
            ? <ul>{historical.dao.similarRecipients.slice(0, 4).map(item => <li key={item.accountId}><code>{item.accountId}</code> · {item.executedTransfers} previous payouts · {item.editDistance} character edit{item.editDistance === 1 ? '' : 's'} away</li>)}</ul>
            : <small>No similar previously paid recipient in the sampled proposals.</small>}</>}
      {'unavailable' in historical.proposedAccountActivity
        ? <p>Target account activity unavailable: {historical.proposedAccountActivity.unavailable}</p>
        : <><p>Target account: {historical.proposedAccountActivity.sampledTransactions} indexed transactions sampled; {historical.proposedAccountActivity.observedLast24hInSample} observed in the last 24 hours{historical.proposedAccountActivity.moreTransactionsAvailable ? ' (sample may be incomplete)' : ''}. Action details loaded for {historical.proposedAccountActivity.hydratedTransactions}{historical.proposedAccountActivity.detailBatchesFailed ? `; ${historical.proposedAccountActivity.detailBatchesFailed} detail batches unavailable` : ''}.</p>
          {historical.proposedAccountActivity.topCounterparties.length > 0 && <p>Frequent counterparties: {historical.proposedAccountActivity.topCounterparties.slice(0, 3).map(item => `${item.accountId} (${item.observations})`).join(', ')}.</p>}
          {historical.proposedAccountActivity.actionTypes.length > 0 && <p>Observed actions: {historical.proposedAccountActivity.actionTypes.slice(0, 4).map(item => `${item.type} (${item.observations})`).join(', ')}.</p>}
          {historical.proposedAccountActivity.sampleTransactionHashes.length > 0 && <p>Sample transactions: {historical.proposedAccountActivity.sampleTransactionHashes.slice(0, 3).map(hash => <a key={hash} href={`https://testnet.nearblocks.io/txns/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 8)}… ↗</a>)}</p>}</>}
      <small>History is evidence for the model, not a scam verdict.</small>
    </div>}
  </div>;
}

function ReviewTimeline({ proposal, ownerId, guardianId, review, history, demoMode }: { proposal: Proposal; ownerId: string; guardianId: string; review?: Review; history?: ReviewSummary; demoMode: boolean }) {
  let submittedAt = '';
  try { if (BigInt(proposal.submission_time) > 0n) submittedAt = new Date(Number(BigInt(proposal.submission_time) / 1_000_000n)).toLocaleString(); } catch { /* Missing chain timestamp. */ }
  const decision = demoMode && proposal.id === DEMO_PROPOSAL_ID ? 'Rejected · illustrative' : review?.aiDecision?.status || history?.status || 'Awaiting review';
  return <div className="review-timeline"><h3>Activity</h3><ol>
    <li><b>Proposal created</b><span>{demoMode ? 'Illustrative only' : submittedAt || 'On-chain'}</span></li>
    <li><b>AI decision</b><span>{decision}</span></li>
    <li><b>Guardian vote</b><span>{demoMode ? 'Withheld in example' : proposal.votes?.[guardianId] ? `${voteLabel(proposal.votes[guardianId])} on-chain` : 'No vote on-chain'}</span></li>
    <li><b>Owner vote</b><span>{demoMode ? 'Not simulated' : proposal.votes?.[ownerId] ? `${voteLabel(proposal.votes[ownerId])} on-chain` : 'Pending'}</span></li>
    <li><b>Execution</b><span>{demoMode ? 'No transaction submitted' : proposal.status === 'Approved' ? 'Executed' : proposal.status === 'InProgress' ? 'Waiting for 2/2' : proposalStatusLabel(proposal.status)}</span></li>
  </ol></div>;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setCopied(false); }
  }
  return <button className="copy-address" aria-label={`Copy ${label}`} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>;
}

function ImpactPanel({ api, proposal, aiStatus }: { api: string; proposal: Proposal; aiStatus?: AiDecision['status'] }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setImpact(null); setError(''); setLoading(false); }, [proposal.id]);

  async function inspect() {
    if (loading) return;
    setLoading(true);
    setImpact(null); setError('');
    try {
      const response = await guardianFetch(`${api}/impact/${proposal.id}`);
      const result = await response.json() as Impact & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not load balance impact');
      setImpact(result);
    } catch (caught) {
      setError(caught instanceof TypeError
        ? 'Cannot reach the local Guardian API. Start the full app with npm run dev, then open http://127.0.0.1:5173/app. If the app is already open, check that Guardian is still running on port 8787.'
        : caught instanceof Error ? caught.message : String(caught));
    }
    finally { setLoading(false); }
  }

  return <section className="panel impact-panel"><div className="panel-head"><div><h2>Estimated balance impact</h2></div></div>
    <p className="hint">Estimated from current balances. No transaction is executed.</p>
    <button className="secondary" disabled={loading} onClick={() => void inspect()}>{loading ? 'Loading impact…' : 'View balance impact'}</button>
    {error && <div className="impact-error" role="alert">{error} <button className="text-link" onClick={() => void inspect()}>Retry</button></div>}
    {impact?.type === 'unavailable' && <p className="impact-error">{impact.reason}</p>}
    {impact?.type === 'balance-projection' && <div className="impact-results"><b>Estimated transfer: {impact.amountNear} NEAR</b><small>{impact.executableFromAvailableBalance ? 'Available balance covers the transfer' : 'Available balance is insufficient; execution may fail'}</small>{aiStatus === 'Rejected' && impact.executableFromAvailableBalance && <div className="exposure-result"><span>Potential exposure in this proposal</span><strong>{impact.amountNear} NEAR</strong><small>Guardian will not approve this proposal. This is not a verified loss avoided.</small></div>}{impact.accounts?.map(account => <div key={account.accountId}><span>{account.accountId}</span><strong>{account.deltaNear} NEAR</strong><small>{account.beforeNear ?? 'Unknown'} → {account.afterNear ?? 'Unknown'} NEAR</small></div>)}<p>Estimate only. No transaction was executed; fees, storage, and concurrent changes are excluded.</p></div>}
  </section>;
}

function WorkspaceApp({ onHome, onOpenApp, onEnterDemo, demoMode, publicDemo = false }: { onHome: () => void; onOpenApp: () => void; onEnterDemo: () => void; demoMode: boolean; publicDemo?: boolean }) {
  const rpcUrl = DEFAULT_RPC;
  const rpc = useMemo(() => new NearRpc(rpcUrl), [rpcUrl]);
  const api = 'http://127.0.0.1:8787';
  const [serviceCheck, setServiceCheck] = useState<{ state: 'checking' | 'online' | 'unfunded' | 'lowbalance' | 'partial' | 'offline'; detail: string; daoId?: string; ownerId?: string; guardianId?: string } | null>(null);
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [accountId, setAccountId] = useState('');
  const [connectedWalletId, setConnectedWalletId] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const walletPickerRef = useRef<HTMLDivElement>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(() => demoMode ? DEMO_DAO : savedTreasury());
  const selectedTreasuryRef = useRef(treasuryKey(treasury));
  const currentRpcRef = useRef(rpcUrl);
  const currentApiRef = useRef(api);
  const serviceCheckRequest = useRef(0);
  const bindingInFlight = useRef(false);
  selectedTreasuryRef.current = treasuryKey(treasury);
  currentRpcRef.current = rpcUrl;
  currentApiRef.current = api;
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [name, setName] = useState('');
  const [importId, setImportId] = useState('');
  const [ownerId, setOwnerId] = useState(() => savedTreasury()?.ownerId || '');
  const [guardianId, setGuardianId] = useState(() => savedTreasury()?.guardianId || '');
  const [detectedMembers, setDetectedMembers] = useState<string[]>([]);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [createDeposit, setCreateDeposit] = useState('5');
  const [balance, setBalance] = useState<string | null>(null);
  const [available, setAvailable] = useState<string | null>(null);
  const [chainPolicy, setChainPolicy] = useState<SputnikPolicy | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [chainLoading, setChainLoading] = useState(true);
  const [chainError, setChainError] = useState('');
  const [receiver, setReceiver] = useState('');
  const [proposalType, setProposalType] = useState<'transfer' | 'call' | 'member'>('transfer');
  const [amount, setAmount] = useState('0.1');
  const [methodName, setMethodName] = useState('run');
  const [jsonArgs, setJsonArgs] = useState('{}');
  const [callDeposit, setCallDeposit] = useState('0');
  const [description, setDescription] = useState('Testnet payout');
  const [fundAmount, setFundAmount] = useState('1');
  const [policy, setPolicy] = useState<GuardianPolicy>(savedPolicy);
  const [receiverText, setReceiverText] = useState(() => savedPolicy().allowedReceivers.join('\n'));
  const [policyDirty, setPolicyDirty] = useState(false);
  const [guardianStatus, setGuardianStatus] = useState<GuardianStatus | null>(null);
  const [guardianChecked, setGuardianChecked] = useState(false);
  const [guardianConnectionError, setGuardianConnectionError] = useState('');
  const [contractsText, setContractsText] = useState(() => Object.entries(savedPolicy().allowedContracts).flatMap(([contract, methods]) => methods.map(method => `${contract}:${method}`)).join('\n'));
  const [reviews, setReviews] = useState<Record<number, Review>>({});
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<number, string>>({});
  const [intentProposalId, setIntentProposalId] = useState<number | null>(null);
  const [intentDraft, setIntentDraft] = useState<IntentDraft>(EMPTY_INTENT_DRAFT);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [guardianFundingFeedback, setGuardianFundingFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmationReason, setConfirmationReason] = useState('');
  const [view, setView] = useState<View>(() => workspaceRoute(demoMode).view);
  const [showTreasuryForm, setShowTreasuryForm] = useState(() => !demoMode && !savedTreasury());
  const [selectedProposalId, setSelectedProposalId] = useState<number | null>(() => workspaceRoute(demoMode).proposalId);
  const [voteConfirmation, setVoteConfirmation] = useState<{ daoId: string; proposal: Proposal; action: 'VoteApprove' | 'VoteReject' } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => { setConfirmationReason(''); }, [selectedProposalId]);
  useEffect(() => {
    localStorage.removeItem('guardian-managed-api-url');
    sessionStorage.removeItem('guardian-managed-token');
    sessionStorage.removeItem('guardian-managed-owner');
  }, []);

  function activateTreasury(next: Treasury) {
    selectedTreasuryRef.current = treasuryKey(next);
    setTreasury(next);
    setBalance(null); setAvailable(null); setChainPolicy(null); setProposals([]);
    setChainLoading(true); setChainError('');
    setGuardianStatus(null); setGuardianChecked(false); setGuardianConnectionError(''); setReviews({}); setReviewErrors({}); setReviewingId(null);
    setVoteConfirmation(null); setConfirmationReason(''); setIntentProposalId(null);
    setPolicyDirty(false); setPolicy(DEFAULT_POLICY);
    setReceiverText(''); setContractsText('');
    localStorage.removeItem(POLICY_STORAGE);
  }

  function navigate(next: View, proposalId: number | null = null) {
    if (demoMode && next !== 'proposals') return;
    setView(next); setSelectedProposalId(proposalId);
    window.history.pushState({}, '', workspacePath(next, proposalId, demoMode));
    setMobileMenuOpen(false);
    document.documentElement.scrollTop = 0;
    requestAnimationFrame(() => { const heading = document.querySelector<HTMLElement>('.page-content h1'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); });
  }

  useEffect(() => {
    const sync = () => { const route = workspaceRoute(demoMode); setView(route.view); setSelectedProposalId(route.proposalId); document.documentElement.scrollTop = 0; };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [demoMode]);

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/meteor-wallet'), import('@near-wallet-selector/nightly')]).then(async ([core, meteorWallet, nightlyWallet]) => {
      const instance = await core.setupWalletSelector({ network: { networkId: 'testnet', nodeUrl: DEFAULT_RPC, helperUrl: 'https://helper.testnet.near.org', explorerUrl: 'https://testnet.nearblocks.io', indexerUrl: 'https://test.api.fastnear.com/v0' }, modules: [meteorWallet.setupMeteorWallet(), nightlyWallet.setupNightly()] });
      if (!active) return;
      setSelector(instance);
      const update = () => {
        const state = instance.store.getState();
        const nextAccount = state.accounts.find(a => a.active)?.accountId || state.accounts[0]?.accountId || '';
        setConnectedWalletId(state.selectedWalletId || '');
        setAccountId(nextAccount);
      };
      update();
      const subscription = instance.store.observable.subscribe(update);
      unsubscribe = () => subscription.unsubscribe();
    }).catch(error => setNotice(String(error)));
    return () => { active = false; unsubscribe?.(); };
  }, [demoMode]);

  useEffect(() => {
    if (!walletPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !walletPickerRef.current?.contains(event.target)) setWalletPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [walletPickerOpen]);

  async function connectWallet(walletId: WalletChoice) {
    if (!selector || walletBusy) return;
    setWalletBusy(true); setNotice(''); setWalletPickerOpen(false);
    try {
      const wallet = await selector.wallet<InjectedWallet>(walletId);
      const accounts = await wallet.signIn({ contractId: FACTORY_ID });
      setAccountId(accounts[0]?.accountId || '');
      setConnectedWalletId(walletId);
      if (!accounts.length) setNotice(`Finish connecting in ${WALLET_NAMES[walletId]}, then return to this page.`);
    } catch (error) {
      const message = String(error);
      if (walletId === 'nightly' && message.includes('not injected')) {
        setNotice('Nightly extension was not found. Install or enable Nightly, then try again.');
        setWalletPickerOpen(true);
      } else setNotice(`Wallet connection failed: ${message}`);
    }
    finally { setWalletBusy(false); }
  }

  async function disconnectWallet() {
    if (!selector || walletBusy) return;
    setWalletBusy(true);
    try {
      const wallet = await selector.wallet();
      await wallet.signOut();
      setAccountId(''); setConnectedWalletId(''); setWalletMenuOpen(false);
    } catch (error) { setNotice(`Could not disconnect wallet: ${String(error)}`); }
    finally { setWalletBusy(false); }
  }

  useEffect(() => { if (mode === 'import' && accountId && !ownerId) setOwnerId(accountId); }, [accountId, mode, ownerId]);

  async function checkService() {
    const requestId = ++serviceCheckRequest.current;
    setServiceCheck({ state: 'checking', detail: 'Checking Guardian service…' });
    try {
      const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(8_000) });
      const result = await response.json() as { ok?: boolean; daoId?: string; ownerId?: string; guardianId?: string; signerConfigured?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || 'Guardian health check failed');
      if (serviceCheckRequest.current !== requestId) return;
      if (!treasury) {
        if (result.guardianId) setGuardianId(result.guardianId);
        if (result.ownerId && mode === 'import') setOwnerId(result.ownerId);
        if (result.daoId?.endsWith('.sputnik-v2.testnet') && mode === 'import') {
          setImportId(result.daoId);
        }
      }
      let signerDetail = 'Signer key not configured';
      let signerVerified = false;
      let signerUnfunded = false;
      let signerLowBalance = false;
      if (result.signerConfigured && result.guardianId) {
        try {
          const challenge = crypto.getRandomValues(new Uint8Array(32));
          const proofResponse = await fetch(`${api}/signer-status?challenge=${encodeURIComponent(Buffer.from(challenge).toString('base64'))}`, { signal: AbortSignal.timeout(12_000) });
          const proof = await proofResponse.json() as { daoId?: string; ownerId?: string; guardianId?: string; publicKey?: string; signature?: string; accountExists?: boolean; error?: string };
          if (!proofResponse.ok || proof.daoId !== result.daoId || proof.ownerId !== result.ownerId || proof.guardianId !== result.guardianId || !proof.publicKey || !proof.signature) throw new Error(proof.error || 'Signer identity differs from Guardian service');
          const { PublicKey } = await import('near-api-js');
          const publicKey = PublicKey.fromString(proof.publicKey);
          if (!publicKey.verify(challenge, Uint8Array.from(Buffer.from(proof.signature, 'base64')))) throw new Error('Guardian challenge signature is invalid');
          const implicitId = Buffer.from(publicKey.data).toString('hex');
          if (proof.accountExists === false && result.guardianId === implicitId) {
            signerUnfunded = true; signerDetail = 'New Guardian key generated · fund its account before creating the multisig';
          } else {
            const access = await rpc.query<{ keys: Array<{ public_key: string }> }>('view_access_key_list', { account_id: result.guardianId });
            if (!access.keys.some(item => item.public_key === proof.publicKey)) throw new Error('Signer key does not match the Guardian account on-chain');
            const balance = await rpc.balance(result.guardianId);
            if (BigInt(balance) < BigInt(nearToYocto('0.1'))) {
              signerLowBalance = true; signerDetail = `Signer verified · ${yoctoToNear(balance)} NEAR left; top up before creating the multisig`;
            } else { signerVerified = true; signerDetail = `Signer verified on-chain · ${yoctoToNear(balance)} NEAR for voting`; }
          }
        } catch (error) { signerDetail = `Signer not verified: ${String(error)}`; }
      }
      if (serviceCheckRequest.current !== requestId) return;
      setServiceCheck({ state: signerVerified ? 'online' : signerUnfunded ? 'unfunded' : signerLowBalance ? 'lowbalance' : 'partial', detail: `Service online · ${signerDetail}`, daoId: result.daoId, ownerId: result.ownerId, guardianId: result.guardianId });
    } catch (error) {
      if (serviceCheckRequest.current === requestId) setServiceCheck({ state: 'offline', detail: `Local Guardian is not running: ${String(error)}. Check the npm run dev terminal.` });
    }
  }

  useEffect(() => { if (!demoMode) void checkService(); }, [demoMode]);

  useEffect(() => {
    if (demoMode) return;
    if (!accountId) return;
    if (treasury && treasury.ownerId !== accountId) {
      if (treasury) {
        selectedTreasuryRef.current = '';
        setTreasury(null); setShowTreasuryForm(true); setProposals([]); setGuardianStatus(null); setSelectedProposalId(null);
        localStorage.removeItem(TREASURY_STORAGE);
        navigate('treasury');
      }
      return;
    }
    if (!serviceCheck || serviceCheck.state === 'checking' || serviceCheck.state === 'offline') return;
    if (!serviceCheck.daoId || !serviceCheck.ownerId) {
      if (treasury) {
        selectedTreasuryRef.current = '';
        localStorage.removeItem(TREASURY_STORAGE);
        setTreasury(null); setShowTreasuryForm(true); setProposals([]); setGuardianStatus(null); setSelectedProposalId(null);
        navigate('treasury');
      }
      return;
    }
    if (serviceCheck.ownerId !== accountId) {
      if (treasury) {
        selectedTreasuryRef.current = '';
        localStorage.removeItem(TREASURY_STORAGE);
        setTreasury(null); setShowTreasuryForm(true); setProposals([]); setGuardianStatus(null); setSelectedProposalId(null);
        navigate('treasury');
      }
      return;
    }
    if (!serviceCheck.guardianId || !isSputnikDaoId(serviceCheck.daoId)) return;
    const next = { daoId: serviceCheck.daoId, ownerId: accountId, guardianId: serviceCheck.guardianId };
    if (treasuryKey(treasury) === treasuryKey(next)) return;
    let active = true;
    void rpc.getPolicy(next.daoId).then(onchain => {
      if (!active) return;
      const council = verifyTwoOfTwo(onchain, next.ownerId, next.guardianId);
      if (!council.ok) throw new Error(council.reasons.join('; '));
      localStorage.setItem(TREASURY_STORAGE, JSON.stringify(next));
      setOwnerId(next.ownerId); setGuardianId(next.guardianId); setImportId(next.daoId);
      activateTreasury(next); setShowTreasuryForm(false); navigate('overview');
    }).catch(error => { if (active) setNotice(`Could not restore this wallet's multisig: ${String(error)}`); });
    return () => { active = false; };
  }, [demoMode, accountId, treasuryKey(treasury), serviceCheck?.state, serviceCheck?.daoId, serviceCheck?.ownerId, serviceCheck?.guardianId, rpc]);

  async function refresh(current = treasury, silent = true) {
    if (!current) return;
    if (demoMode) { setProposals([DEMO_PROPOSAL]); setChainError(''); setChainLoading(false); return; }
    const expectedTreasury = treasuryKey(current);
    const expectedRpc = rpcUrl;
    try {
      const [b, a, p, list] = await Promise.all([rpc.balance(current.daoId), rpc.getAvailableAmount(current.daoId).catch(() => null), rpc.getPolicy(current.daoId), rpc.getRecentProposals(current.daoId)]);
      if (selectedTreasuryRef.current !== expectedTreasury || currentRpcRef.current !== expectedRpc) return;
      setBalance(yoctoToNear(b)); setAvailable(a ? yoctoToNear(a) : null); setChainPolicy(p); setProposals(list); setChainError(''); setChainLoading(false); if (!silent) setNotice('On-chain data refreshed.');
    } catch (error) {
      if (selectedTreasuryRef.current !== expectedTreasury || currentRpcRef.current !== expectedRpc) return;
      const message = `Could not read on-chain data: ${String(error)}`;
      setChainError(message); setChainLoading(false);
      if (!silent) setNotice(message);
    }
  }

  useEffect(() => {
    setBalance(null); setAvailable(null); setChainPolicy(null); setProposals([]);
    if (demoMode) { setProposals([DEMO_PROPOSAL]); setChainError(''); setChainLoading(false); }
    else if (treasury) { setChainLoading(true); setChainError(''); void refresh(treasury); }
  }, [treasury?.daoId, rpc, demoMode]);

  async function loadGuardian(current = treasury, apiUrl = api) {
    if (!current) return;
    const expectedTreasury = treasuryKey(current);
    try {
      const response = await guardianFetch(`${apiUrl}/status`);
      const data = await response.json() as GuardianStatus & { error?: string };
      if (selectedTreasuryRef.current !== expectedTreasury || currentApiRef.current !== apiUrl) return;
      if (!response.ok) throw new Error(data.error || 'Could not load Guardian status');
      if (data.daoId !== current.daoId || data.ownerId !== current.ownerId || data.guardianId !== current.guardianId) throw new Error('Guardian service is connected to a different multisig');
      setGuardianStatus(data); setGuardianChecked(true); setGuardianConnectionError('');
      if (!policyDirty) { setPolicy(data.policy); setReceiverText(data.policy.allowedReceivers.join('\n')); setContractsText(Object.entries(data.policy.allowedContracts).flatMap(([contract, methods]) => methods.map(method => `${contract}:${method}`)).join('\n')); }
    } catch (error) { if (selectedTreasuryRef.current === expectedTreasury && currentApiRef.current === apiUrl) { setGuardianStatus(null); setGuardianChecked(true); setGuardianConnectionError(String(error)); } }
  }

  async function refreshWorkspace(current = treasury) {
    if (!current) return;
    await Promise.all([refresh(current, false), loadGuardian(current)]);
  }

  useEffect(() => {
    setGuardianStatus(null); setGuardianConnectionError(''); setReviews({}); setReviewErrors({});
    if (treasury && !demoMode) { setGuardianChecked(false); void loadGuardian(treasury); }
  }, [treasury?.daoId, api, demoMode]);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const pending = sessionStorage.getItem('guardian-pending-signature');
    if (!pending || !hash.has('state')) return;
    try {
      const data = JSON.parse(pending) as PendingSignature;
      if (hash.get('state') !== data.state) throw new Error('Wallet signature callback did not match');
      if (hash.get('error')) throw new Error(hash.get('error') || 'Wallet declined the signature');
      const signed: SignedIntentEnvelope = { ...data, accountId: hash.get('accountId') || '', publicKey: hash.get('publicKey') || '', signature: hash.get('signature') || '' };
      sessionStorage.removeItem('guardian-pending-signature');
      const returnPath = data.returnPath && /^\/app(?:\/|$)/.test(data.returnPath) && !data.returnPath.startsWith('/app/demo') ? data.returnPath : '/app';
      window.history.replaceState(null, '', returnPath);
      const route = workspaceRoute(false); setView(route.view); setSelectedProposalId(route.proposalId);
      void submitSigned(data.kind, signed);
    } catch (error) { setNotice(String(error)); }
  }, []);

  const council = useMemo(() => chainPolicy && treasury ? verifyTwoOfTwo(chainPolicy, treasury.ownerId, treasury.guardianId) : null, [chainPolicy, treasury]);

  async function transact(receiverId: string, actions: TxAction[], requireWalletApproval = false) {
    if (demoMode) throw new Error('The demo is read-only. Open the app to sign with your own multisig.');
    if (!selector || !accountId) throw new Error('Connect a Testnet wallet first');
    const wallet = await selector.wallet();
    const result = requireWalletApproval
      ? (await wallet.signAndSendTransactions({ transactions: [{ signerId: accountId, receiverId, actions }] }))?.[0]
      : await wallet.signAndSendTransaction({ signerId: accountId, receiverId, actions });
    if (result && 'status' in result && typeof result.status === 'object' && 'Failure' in result.status) throw new Error(JSON.stringify(result.status.Failure));
    return result;
  }

  async function createOrImport() {
    setBusy(true); setNotice('');
    try {
      const selectedOwnerId = mode === 'create' ? accountId : ownerId;
      if (!selectedOwnerId || !isTestnetAccount(selectedOwnerId) || !isTestnetAccount(guardianId) || selectedOwnerId === guardianId) throw new Error('Connect an Owner wallet and verify the Guardian account');
      const id = mode === 'create' ? daoIdFromName(name) : importId.trim();
      if (!isSputnikDaoId(id)) throw new Error('Enter a Sputnik V2 Testnet multisig address');
      const next = { daoId: id, ownerId: selectedOwnerId, guardianId };
      const healthResponse = await fetch(`${api}/health`, { signal: AbortSignal.timeout(8_000) });
      const health = await healthResponse.json() as { daoId?: string; ownerId?: string; guardianId?: string; error?: string };
      const needsBinding = !health.daoId && !health.ownerId;
      if (!healthResponse.ok || health.guardianId !== guardianId || (!needsBinding && (health.daoId !== id || health.ownerId !== selectedOwnerId))) throw new Error('This local Guardian is bound to a different Owner or multisig. Use a separate self-hosted instance for another user or DAO.');
      if (mode === 'create') {
        if (!accountId) throw new Error('Connect the Owner wallet before creating the multisig');
        const signerApi = api;
        const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const proofResponse = await fetch(`${signerApi}/signer-status?challenge=${encodeURIComponent(challenge.toString('base64'))}`);
        const proof = await proofResponse.json() as { daoId?: string; ownerId?: string; guardianId?: string; publicKey?: string; signature?: string; error?: string };
        if (!proofResponse.ok || (needsBinding ? Boolean(proof.daoId || proof.ownerId) : proof.daoId !== id || proof.ownerId !== selectedOwnerId) || proof.guardianId !== guardianId || !proof.publicKey || !proof.signature) throw new Error(proof.error || 'Self-hosted Guardian signer is not ready for this DAO');
        const [{ PublicKey }, access] = await Promise.all([import('near-api-js'), rpc.query<{ keys: Array<{ public_key: string }> }>('view_access_key_list', { account_id: guardianId })]);
        if (!access.keys.some(item => item.public_key === proof.publicKey) || !PublicKey.fromString(proof.publicKey).verify(Uint8Array.from(challenge), Uint8Array.from(Buffer.from(proof.signature, 'base64')))) throw new Error('Guardian signer does not control the on-chain Guardian account');
        const args = createDaoArgs(name, selectedOwnerId, guardianId);
        const deposit = nearToYocto(createDeposit);
        if (BigInt(deposit) < BigInt(nearToYocto('5'))) throw new Error('Choose at least 5 NEAR of initial multisig funding to cover the deployed DAO contract storage');
        localStorage.setItem(PENDING_TREASURY_STORAGE, JSON.stringify(next));
        try { const actions = await nearActionCreators(); await transact(FACTORY_ID, [actions.functionCall('create', args, 150_000_000_000_000n, BigInt(deposit))]); }
        catch (error) { localStorage.removeItem(PENDING_TREASURY_STORAGE); throw error; }
        setNotice('Creation submitted. Waiting for on-chain confirmation and Council verification…');
        await waitForCreatedTreasury(next, rpc);
      } else {
        const onchain = await rpc.getPolicy(id);
        const council = verifyTwoOfTwo(onchain, selectedOwnerId, guardianId);
        if (!council.ok) throw new Error(`The on-chain multisig members do not match the entered accounts: ${council.reasons.join('; ')}`);
      }
      if (needsBinding) { await signBinding(next); return; }
      localStorage.removeItem(PENDING_TREASURY_STORAGE);
      localStorage.setItem(TREASURY_STORAGE, JSON.stringify(next)); activateTreasury(next); setShowTreasuryForm(false); navigate('overview'); await refresh(next);
    } catch (error) { setNotice(`Multisig setup failed: ${String(error)}${mode === 'create' && localStorage.getItem(PENDING_TREASURY_STORAGE) ? '. If the creation transaction succeeded, refresh to retry verification.' : ''}`); }
    finally { setBusy(false); }
  }

  async function fundGuardian() {
    ensureWalletBuffer();
    setBusy(true); setNotice(''); setGuardianFundingFeedback({ message: 'Verifying the Guardian account and wallet connection…', error: false });
    try {
      if (walletBusy) throw new Error('Finish connecting your wallet before funding the Guardian');
      const id = serviceCheck?.guardianId;
      if (!id || !['unfunded', 'lowbalance'].includes(serviceCheck.state) || !isTestnetAccount(id)) throw new Error('Guardian does not need funding');
      if (!accountId || (serviceCheck.ownerId && accountId !== serviceCheck.ownerId)) throw new Error('Connect the Owner wallet first');
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const response = await fetch(`${api}/signer-status?challenge=${encodeURIComponent(btoa(String.fromCharCode(...challenge)))}`, { signal: AbortSignal.timeout(12_000) });
      const proof = await response.json() as { publicKey?: string; signature?: string; guardianId?: string; error?: string };
      if (!response.ok || !proof.publicKey || !proof.signature || proof.guardianId !== id) throw new Error(proof.error || 'Guardian signing proof is unavailable');
      const { PublicKey } = await import('near-api-js');
      const publicKey = PublicKey.fromString(proof.publicKey);
      if (!publicKey.verify(challenge, Uint8Array.from(atob(proof.signature), char => char.charCodeAt(0)))) throw new Error('Guardian signing proof is invalid');
      if (/^[0-9a-f]{64}$/.test(id)) {
        if (Array.from(publicKey.data, byte => byte.toString(16).padStart(2, '0')).join('') !== id) throw new Error('Guardian address does not match its signing key');
      } else {
        const access = await rpc.query<{ keys: Array<{ public_key: string }> }>('view_access_key_list', { account_id: id });
        if (!access.keys.some(item => item.public_key === proof.publicKey)) throw new Error('Guardian key does not match its on-chain account');
      }
      const actions = await nearActionCreators();
      setGuardianFundingFeedback({ message: 'Opening your wallet. Approve the 0.5 NEAR transfer to the Guardian account there.', error: false });
      const result = await transact(id, [actions.transfer(BigInt(nearToYocto('0.5')))], true);
      setGuardianFundingFeedback({ message: result ? 'Transfer confirmed by your wallet. Checking the Guardian account on-chain…' : 'Complete the transfer in your wallet, then refresh Guardian status here.', error: false });
      await checkService();
      if (result) setGuardianFundingFeedback({ message: 'Transfer submitted. If the account still shows as unfunded, wait a few seconds and click Refresh status.', error: false });
    } catch (error) {
      const detail = /Wallet not signed in/i.test(String(error)) ? 'Wallet session expired. Disconnect and reconnect your wallet, then try again.' : String(error);
      setGuardianFundingFeedback({ message: `Could not fund Guardian: ${detail}`, error: true });
      setNotice(`Could not fund Guardian: ${detail}`);
    }
    finally { setBusy(false); }
  }

  async function detectCouncil() {
    const id = importId.trim();
    setLookupError(''); setDetectedMembers([]);
    if (!isSputnikDaoId(id)) { setLookupError('Enter a Sputnik V2 Testnet multisig address first.'); return; }
    setLookupBusy(true);
    try {
      const onchain = await rpc.getPolicy(id);
      const councilRole = onchain.roles.find(role => role.name === 'council');
      const members = councilRole && typeof councilRole.kind === 'object' ? councilRole.kind.Group : [];
      if (!members || members.length !== 2 || !verifyTwoOfTwo(onchain, members[0], members[1]).ok) throw new Error('This account is not a supported 2-of-2 Sputnik DAO V2 multisig');
      const owner = members.includes(accountId) ? accountId : members[0];
      setDetectedMembers(members);
      setOwnerId(owner); setGuardianId(members.find(member => member !== owner) || '');
    } catch (error) { setLookupError(String(error)); }
    finally { setLookupBusy(false); }
  }

  useEffect(() => {
    const pending = localStorage.getItem(PENDING_TREASURY_STORAGE);
    if (!pending) return;
    let active = true;
    try {
      const next = JSON.parse(pending) as Treasury;
      if (!isSputnikDaoId(next.daoId) || !isTestnetAccount(next.ownerId) || !isTestnetAccount(next.guardianId)) throw new Error('Pending multisig details are invalid');
      if (!selector || accountId !== next.ownerId || sessionStorage.getItem('guardian-pending-signature') || bindingInFlight.current) return;
      void waitForCreatedTreasury(next, rpc).then(async () => {
        if (!active) return;
        const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(8_000) });
        const health = await response.json() as { daoId?: string; ownerId?: string; guardianId?: string };
        if (!response.ok || health.guardianId !== next.guardianId) throw new Error('Local Guardian identity differs from the pending multisig');
        if (!health.daoId && !health.ownerId) { await signBinding(next); return; }
        if (health.daoId !== next.daoId || health.ownerId !== next.ownerId) throw new Error('Local Guardian is bound to another multisig');
        localStorage.setItem(TREASURY_STORAGE, JSON.stringify(next));
        localStorage.removeItem(PENDING_TREASURY_STORAGE); activateTreasury(next); setShowTreasuryForm(false);
      }).catch(error => { if (active) setNotice(`Creation has not passed verification: ${String(error)}. Refresh to retry.`); });
    } catch (error) { localStorage.removeItem(PENDING_TREASURY_STORAGE); setNotice(String(error)); }
    return () => { active = false; };
  }, [selector, accountId]);

  async function fund() {
    if (!treasury || !selector || !accountId) return;
    setBusy(true);
    try {
      if (!council?.ok) throw new Error('The on-chain 2-of-2 setup is not verified yet; deposits are disabled');
      if (BigInt(nearToYocto(fundAmount)) <= 0n) throw new Error('Deposit amount must be greater than 0');
      const actions = await nearActionCreators();
      await transact(treasury.daoId, [actions.transfer(BigInt(nearToYocto(fundAmount)))]);
      setNotice('Deposit submitted. Refresh the balance after returning from your wallet.'); await refresh();
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }

  async function propose() {
    if (!treasury || !chainPolicy) return;
    setBusy(true);
    try {
      if (!council?.ok) throw new Error('The on-chain 2-of-2 setup is not verified yet');
      const args = proposalType === 'transfer' ? transferProposal(receiver, amount, description) : proposalType === 'call' ? functionCallProposal(receiver, methodName, jsonArgs, callDeposit, description) : addCouncilMemberProposal(receiver, description);
      const actions = await nearActionCreators();
      await transact(treasury.daoId, [actions.functionCall('add_proposal', args, 150_000_000_000_000n, BigInt(chainPolicy.proposal_bond))]);
      setNotice('On-chain proposal submitted. You can view it in the proposal list after returning from your wallet.'); setSelectedProposalId(null); await refresh(); navigate('proposals');
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }

  async function prepareVote(proposal: Proposal, action: 'VoteApprove' | 'VoteReject') {
    if (!treasury || demoMode) return;
    const expectedTreasury = treasuryKey(treasury);
    setBusy(true);
    try {
      if (!accountId) throw new Error('Connect a Council wallet before voting');
      if (accountId !== treasury.ownerId && accountId !== treasury.guardianId) throw new Error('The connected wallet is not a multisig member');
      if (action === 'VoteApprove' && accountId !== treasury.ownerId) throw new Error('Guardian approval must come from the independent review service');
      const [onchain, currentPolicy] = await Promise.all([rpc.getProposal(treasury.daoId, proposal.id), rpc.getPolicy(treasury.daoId)]);
      if (selectedTreasuryRef.current !== expectedTreasury) throw new Error('The selected multisig changed. Open the proposal again');
      if (!verifyTwoOfTwo(currentPolicy, treasury.ownerId, treasury.guardianId).ok) throw new Error('The on-chain 2-of-2 Council changed. Refresh before voting');
      if (onchain.status !== 'InProgress' || !sameProposalKind(onchain.kind, proposal.kind)) throw new Error('The on-chain proposal changed. Refresh before voting');
      if (onchain.votes?.[accountId]) throw new Error('This account has already voted');
      setVoteConfirmation({ daoId: treasury.daoId, proposal: onchain, action });
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function vote(proposal: Proposal, action: 'VoteApprove' | 'VoteReject', expectedDaoId: string) {
    if (!treasury) return;
    const expectedTreasury = treasuryKey(treasury);
    setBusy(true);
    try {
      if (!council?.ok) throw new Error('The on-chain 2-of-2 setup is not verified yet');
      if (treasury.daoId !== expectedDaoId) { setVoteConfirmation(null); throw new Error('The selected multisig changed. Open the proposal again'); }
      if (accountId !== treasury.ownerId && accountId !== treasury.guardianId) throw new Error('The connected wallet is not a multisig member');
      if (accountId === treasury.guardianId && action === 'VoteApprove') throw new Error('Guardian approval must come from the independent review service');
      const [onchain, currentPolicy] = await Promise.all([rpc.getProposal(treasury.daoId, proposal.id), rpc.getPolicy(treasury.daoId)]);
      if (selectedTreasuryRef.current !== expectedTreasury) { setVoteConfirmation(null); throw new Error('The selected multisig changed. Open the proposal again'); }
      if (!verifyTwoOfTwo(currentPolicy, treasury.ownerId, treasury.guardianId).ok) { setVoteConfirmation(null); throw new Error('The on-chain 2-of-2 Council changed. Refresh before voting'); }
      if (onchain.status !== 'InProgress' || !sameProposalKind(onchain.kind, proposal.kind)) { setVoteConfirmation(null); throw new Error('The on-chain proposal changed. Refresh and review again'); }
      if (onchain.votes?.[accountId]) { setVoteConfirmation(null); throw new Error('This account has already voted'); }
      if (!sameVotes(onchain.votes, proposal.votes)) { setVoteConfirmation(null); throw new Error('The proposal votes changed while the confirmation was open. Review the updated approval state and try again'); }
      const actions = await nearActionCreators();
      if (selectedTreasuryRef.current !== expectedTreasury) { setVoteConfirmation(null); throw new Error('The selected multisig changed. Open the proposal again'); }
      await transact(treasury.daoId, [actions.functionCall('act_proposal', { id: onchain.id, action, proposal: onchain.kind, memo: 'Guardian UI vote' }, 100_000_000_000_000n, 0n)]);
      setVoteConfirmation(null);
      setNotice('Vote submitted. Refresh the proposal after returning from your wallet.'); await refresh();
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }

  async function review(id: number) {
    if (reviewingId === id) return;
    const expectedTreasury = selectedTreasuryRef.current;
    const expectedApi = api;
    setReviewingId(id);
    setReviewErrors(current => { const next = { ...current }; delete next[id]; return next; });
    try {
      const response = await guardianFetch(`${api}/review/${id}`, { method: 'POST' });
      const json = await response.json();
      if (selectedTreasuryRef.current !== expectedTreasury || currentApiRef.current !== expectedApi) return;
      if (!response.ok) throw new Error(json.error || 'Guardian review failed');
      setReviews(current => ({ ...current, [id]: json as Review }));
      await Promise.all([loadGuardian(), refresh()]);
    } catch (error) { if (selectedTreasuryRef.current === expectedTreasury && currentApiRef.current === expectedApi) { setReviewErrors(current => ({ ...current, [id]: String(error) })); await loadGuardian(); } }
    finally { if (selectedTreasuryRef.current === expectedTreasury && currentApiRef.current === expectedApi) setReviewingId(null); }
  }

  async function submitSigned(kind: 'bind' | 'intent' | 'policy' | 'confirmation', signed: SignedIntentEnvelope) {
    const expectedTreasury = selectedTreasuryRef.current;
    const expectedApi = api;
    if (kind === 'bind') bindingInFlight.current = true;
    try {
      const response = await guardianFetch(`${api}/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
      const json = await response.json();
      if (selectedTreasuryRef.current !== expectedTreasury || currentApiRef.current !== expectedApi) return;
      if (!response.ok) throw new Error(json.error || 'Signature verification failed');
      if (kind === 'bind') {
        const binding = JSON.parse(signed.message) as { daoId: string; ownerId: string; guardianId: string };
        const next = { daoId: binding.daoId, ownerId: binding.ownerId, guardianId: binding.guardianId };
        if (json.daoId !== next.daoId || json.ownerId !== next.ownerId || json.guardianId !== next.guardianId) throw new Error('Guardian binding response differs from the signed request');
        localStorage.removeItem(PENDING_TREASURY_STORAGE);
        localStorage.setItem(TREASURY_STORAGE, JSON.stringify(next));
        activateTreasury(next); setShowTreasuryForm(false); navigate('overview');
        setNotice('Guardian bound to this multisig with an independent Owner signature.');
        await refresh(next); await loadGuardian(next); await checkService();
        return;
      }
      if (kind === 'intent' || kind === 'confirmation') {
        setNotice(kind === 'intent' ? json.matchesProposal === false ? `Proposal #${json.proposalId} intent signature verified. The intended action differs from the proposal. Click Review proposal to assess it.` : `Proposal #${json.proposalId} intent was signed and verified. Click Review proposal when ready.` : `Proposal #${json.proposalId} confirmation signed. Click Review proposal to assess it again.`);
      } else {
        setPolicyDirty(false);
        setNotice('The review policy was signed by the Owner and saved.');
        await loadGuardian();
      }
    } catch (error) { if (selectedTreasuryRef.current === expectedTreasury && currentApiRef.current === expectedApi) setNotice(`Could not submit signature: ${String(error)}`); }
    finally { if (kind === 'bind') bindingInFlight.current = false; }
  }

  async function signBinding(next: Treasury) {
    if (!selector || accountId !== next.ownerId) throw new Error('Connect the Owner wallet to bind Guardian');
    const wallet = await selector.wallet();
    if (!wallet.signMessage) throw new Error('This wallet does not support NEP-413 message signing');
    const message = JSON.stringify({ type: 'near-guardian-bind', version: 1, ...next, expiresAt: Date.now() + 10 * 60_000 });
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const callbackUrl = `${window.location.origin}/app`;
    const state = crypto.randomUUID();
    const pending: PendingSignature = { kind: 'bind', message, nonce: nonce.toString('base64'), callbackUrl, state, returnPath: window.location.pathname };
    sessionStorage.setItem('guardian-pending-signature', JSON.stringify(pending));
    let signed;
    try { signed = await wallet.signMessage({ message, recipient: `near-guardian:${next.daoId}`, nonce, callbackUrl, state }); }
    catch (error) { sessionStorage.removeItem('guardian-pending-signature'); throw error; }
    if (signed) {
      sessionStorage.removeItem('guardian-pending-signature');
      await submitSigned('bind', { message, nonce: pending.nonce, callbackUrl, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature });
    } else setNotice('Waiting for Owner wallet signature to bind Guardian.');
  }

  async function signPayload(kind: 'intent' | 'policy' | 'confirmation', message: string) {
    if (!selector || !treasury || accountId !== treasury.ownerId) throw new Error('Connect the Owner wallet before signing');
    const wallet = await selector.wallet();
    if (!wallet.signMessage) throw new Error('This wallet does not support NEP-413 message signing');
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const callbackUrl = `${window.location.origin}/app`;
    const state = crypto.randomUUID();
    const pending: PendingSignature = { kind, message, nonce: nonce.toString('base64'), callbackUrl, state, returnPath: window.location.pathname };
    sessionStorage.setItem('guardian-pending-signature', JSON.stringify(pending));
    let signed;
    try { signed = await wallet.signMessage({ message, recipient: `near-guardian:${treasury.daoId}`, nonce, callbackUrl, state }); }
    catch (error) { sessionStorage.removeItem('guardian-pending-signature'); throw error; }
    if (signed) {
      sessionStorage.removeItem('guardian-pending-signature');
      await submitSigned(kind, { message, nonce: pending.nonce, callbackUrl, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature });
    } else setNotice('Waiting for wallet signature.');
  }

  async function signIntent(proposal: Proposal) {
    if (!treasury || typeof proposal.kind !== 'object' || (!proposal.kind.Transfer && !proposal.kind.FunctionCall)) { setNotice('Signed intent is currently available for transfers and contract calls.'); return; }
    try {
      const base = { version: 1, daoId: treasury.daoId, proposalId: proposal.id, proposer: proposal.proposer, expiresAt: Date.now() + 10 * 60_000 };
      const message = intentDraft.action === 'transfer'
        ? (() => { const expected = transferProposal(intentDraft.receiverId, intentDraft.amountNear, 'Owner intended transfer').proposal.kind.Transfer; return JSON.stringify({ ...base, type: 'near-guardian-transfer', receiverId: expected.receiver_id, tokenId: expected.token_id, amount: expected.amount }); })()
        : (() => { const text = intentDraft.text.trim(); if (text.length < 10 || text.length > 2000) throw new Error('Describe the intended contract call in 10–2000 characters'); return JSON.stringify({ ...base, type: 'near-guardian-narrative', action: 'call', text }); })();
      await signPayload('intent', message);
    } catch (error) { setNotice(String(error)); }
  }

  async function signConfirmation(proposal: Proposal) {
    try {
      if (!treasury || proposal.status !== 'InProgress') throw new Error('Select a pending proposal');
      const result = reviews[proposal.id];
      if (result?.aiDecision?.status !== 'Needs user confirmation' || !result.policyHash) throw new Error('This review does not require Owner confirmation');
      const reason = confirmationReason.trim();
      if (!reason) throw new Error('Explain why you approve this on-chain action before signing');
      const onchain = await rpc.getProposal(treasury.daoId, proposal.id);
      if (onchain.status !== 'InProgress' || !sameProposalKind(onchain.kind, proposal.kind)) throw new Error('The on-chain proposal changed. Refresh and review it again');
      await signPayload('confirmation', JSON.stringify({ type: 'near-guardian-confirmation', version: 1, daoId: treasury.daoId, proposalId: proposal.id, proposalKind: onchain.kind, policyHash: result.policyHash, reason, expiresAt: Date.now() + 10 * 60_000 }));
    } catch (error) { setNotice(String(error)); }
  }

  function openIntentEditor(id: number) {
    const selected = proposals.find(proposal => proposal.id === id);
    setIntentDraft({ ...EMPTY_INTENT_DRAFT, action: selected && typeof selected.kind === 'object' && selected.kind.FunctionCall ? 'call' : 'transfer' });
    setIntentProposalId(current => current === id ? null : id);
  }

  async function applyPolicy() {
    try {
      if (!treasury) throw new Error('Select a multisig first');
      const next = validateGuardianPolicy({ ...policy, allowedReceivers: receiversFromText(receiverText), allowedContracts: contractsFromText(contractsText) });
      savePolicy(next);
      await signPayload('policy', JSON.stringify({ type: 'near-guardian-policy', version: 1, daoId: treasury.daoId, policy: next, expiresAt: Date.now() + 10 * 60_000 }));
    } catch (error) { setNotice(String(error)); }
  }

  function savePolicy(next: GuardianPolicy) { setPolicy(next); setPolicyDirty(true); localStorage.setItem(POLICY_STORAGE, JSON.stringify(next)); }
  function downloadPolicy() {
    try {
      const next = validateGuardianPolicy({ ...policy, allowedReceivers: receiversFromText(receiverText), allowedContracts: contractsFromText(contractsText) });
      const blob = new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'guardian-policy.json'; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setNotice(String(error)); }
  }

  const activeView: View = treasury ? view : 'treasury';
  const guardianAssignedToAnotherOwner = Boolean(accountId && serviceCheck?.ownerId && serviceCheck.ownerId !== accountId);
  const pendingProposals = proposals.filter(proposal => proposal.status === 'InProgress');
  const activeProposal = proposals.find(proposal => proposal.id === selectedProposalId);
  const activeTarget = activeProposal && typeof activeProposal.kind === 'object'
    ? (activeProposal.kind.Transfer as { receiver_id?: string } | undefined)?.receiver_id || (activeProposal.kind.FunctionCall as { receiver_id?: string } | undefined)?.receiver_id || null
    : null;
  const reviewHistory = Object.fromEntries((guardianStatus?.reviews || []).map(item => [item.proposalId, item])) as Record<number, ReviewSummary>;
  const viewTitle: Record<View, string> = { overview: 'Overview', proposals: 'Proposals', new: 'New proposal', policy: 'Review policy', treasury: 'Multisig' };

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={onHome} aria-label="AI Guardian home">
        <span className="brand-mark"><GuardianMark/></span><span>AI Guardian</span>
      </button>
      <button className="mobile-menu-toggle" aria-expanded={mobileMenuOpen} aria-controls="workspace-navigation" onClick={() => setMobileMenuOpen(value => !value)}>{mobileMenuOpen ? 'Close menu' : 'Menu'} <span aria-hidden="true">{mobileMenuOpen ? '×' : '☰'}</span></button>
      <button className="account-switcher" disabled={demoMode && publicDemo} onClick={() => demoMode ? onOpenApp() : navigate('treasury')}><span className="account-avatar" aria-hidden="true">2/2</span><span className="account-copy"><small>{demoMode ? 'Read-only demo' : treasury ? 'Current multisig' : 'Get started'}</small><strong>{treasury ? treasury.daoId.replace('.sputnik-v2.testnet', '') : 'Connect multisig'}</strong></span><span className="account-chevron" aria-hidden="true">⌄</span></button>
      <div className="sidebar-caption">Workspace</div>
      <nav id="workspace-navigation" className={`side-nav ${mobileMenuOpen ? 'mobile-open' : ''}`} aria-label="Main navigation">
        {(demoMode ? NAV.filter(item => item.id === 'proposals') : treasury ? NAV : NAV.filter(item => item.id === 'treasury')).map(item =>
          <button key={item.id} className={`nav-item ${activeView === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-current={activeView === item.id ? 'page' : undefined} aria-label={!treasury && item.id === 'treasury' ? 'Connect multisig' : item.label} title={!treasury && item.id === 'treasury' ? 'Connect multisig' : item.label}>
            <span className="nav-icon"><NavIcon view={item.id}/></span><span>{!treasury && item.id === 'treasury' ? 'Connect multisig' : item.label}</span>{item.id === 'proposals' && pendingProposals.length > 0 && <b>{pendingProposals.length}</b>}
          </button>
        )}
      </nav>
      <div className="sidebar-bottom"><span className="testnet-mark"><i/> {demoMode ? 'Illustrative preview' : 'NEAR Testnet'}</span><small>{demoMode ? 'No wallet or transaction required' : 'All transactions run on Testnet'}</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>{demoMode ? 'Read-only demo' : treasury ? 'My multisig' : 'AI Guardian'}</span><span>/</span><strong>{!treasury && activeView === 'treasury' ? 'Connect multisig' : viewTitle[activeView]}</strong></div>
        <div className="top-actions"><span className="network-chip"><i/> Testnet</span>
          {demoMode ? publicDemo ? <span className="wallet">Public preview</span> : <button className="wallet" onClick={onOpenApp}>Open app</button>
            : accountId ? <div className="wallet-account"><button className="wallet" aria-expanded={walletMenuOpen} aria-label={`Wallet ${accountId}`} onClick={() => setWalletMenuOpen(current => !current)}>{accountId}</button>{walletMenuOpen && <div className="wallet-menu"><span>Connected with {WALLET_NAMES[connectedWalletId as WalletChoice] || 'NEAR wallet'}</span><code>{accountId}</code><button disabled={walletBusy} onClick={() => void disconnectWallet()}>Disconnect</button></div>}</div>
              : <div className="wallet-account" ref={walletPickerRef} onKeyDown={event => { if (event.key === 'Escape') setWalletPickerOpen(false); }}>
                  <button className="wallet" aria-expanded={walletPickerOpen} aria-controls="wallet-picker" disabled={!selector || walletBusy} onClick={() => setWalletPickerOpen(open => !open)}>{walletBusy ? 'Connecting…' : 'Connect wallet'}</button>
                  {walletPickerOpen && <div id="wallet-picker" className="wallet-picker" role="group" aria-label="Choose a Testnet wallet">
                    <span>Choose a wallet <small>NEAR Testnet</small></span>
                    <button autoFocus onClick={() => void connectWallet('meteor-wallet')}><strong>Meteor Wallet</strong><small>Browser extension</small></button>
                    <button onClick={() => void connectWallet('nightly')}><strong>Nightly Wallet</strong><small>Browser extension</small></button>
                    <a href="https://nightly.app/download" target="_blank" rel="noreferrer">Get Nightly ↗</a>
                  </div>}
                </div>}
        </div>
      </header>
      <main className={`page-content ${!treasury && activeView === 'treasury' ? 'is-onboarding' : ''}`}>
        {demoMode && <div className="demo-workspace-banner"><div><strong>Illustrative workspace preview</strong><span>Example proposal and review decision. No on-chain transaction or model request was made; create a multisig with your wallet for a live Testnet result.</span></div>{!publicDemo && <button onClick={onOpenApp}>Use your multisig →</button>}</div>}
        {treasury && chainError && <div className="service-alert" role="alert"><div><strong>On-chain data unavailable</strong><span>{chainError}. The proposal list may be out of date.</span></div><button onClick={() => void refresh(treasury, false)}>Retry RPC read</button></div>}
        {treasury && !demoMode && guardianChecked && !guardianStatus && <div className="service-alert" role="status"><div><strong>Local Guardian not ready</strong><span>{guardianConnectionError || 'Guardian review is unavailable until the local service reconnects.'}</span></div><button onClick={() => { void checkService(); void loadGuardian(); }}>Retry connection</button></div>}
        {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}

        {activeView === 'overview' && treasury && <>
          <div className="page-title"><div><h1>Overview</h1><p>Pending on-chain actions and Guardian decisions, in one place.</p></div>{!demoMode && <div className="page-actions"><button className="secondary" onClick={() => void refreshWorkspace()}>Refresh</button><button className="secondary" onClick={() => navigate('treasury')}>Fund multisig</button><button className="primary" onClick={() => navigate('new')}>New proposal</button></div>}</div>
          {!demoMode && council?.ok && !guardianStatus?.ai?.ready && <section className="next-step"><div><span>Local Guardian</span><strong>Review model has not been tested yet.</strong><p>Check the AI settings in your private .env. Open a proposal and click Review proposal when ready.</p></div><button className="secondary" onClick={() => { void checkService(); void loadGuardian(); }}>Refresh status</button></section>}
          <section className="activity-section">
            <div className="section-heading"><div><span className="section-kicker">Review queue</span><h2>Pending proposals <span>{pendingProposals.length}</span></h2></div><button className="text-link" onClick={() => navigate('proposals')}>View all proposals →</button></div>
            {chainLoading && proposals.length === 0 ? <div className="table-empty"><b>Loading on-chain proposals…</b></div> : chainError && proposals.length === 0 ? <div className="table-empty"><b>Could not load proposals</b><p>Retry the RPC read above.</p></div> : pendingProposals.length === 0 ? <div className="table-empty"><b>No pending proposals</b><p>New proposals will appear here after submission.</p>{!demoMode && <button className="secondary" onClick={() => navigate('new')}>New proposal</button>}</div> : <div className="transaction-list"><div className="transaction-list-head"><span>On-chain action</span><span>Unverified note</span><span>Guardian</span><span>Approvals</span><span/></div>{pendingProposals.slice(0, 5).map(proposal => <ProposalRow key={proposal.id} proposal={proposal} guardianId={treasury.guardianId} review={reviews[proposal.id]} history={reviewHistory[proposal.id]} demoMode={demoMode} onOpen={() => { setIntentProposalId(null); navigate('proposals', proposal.id); }}/>)}</div>}
          </section>
          <section className="account-overview" aria-label="Multisig overview">
            <div className="account-balance"><span>Multisig balance</span><strong>{balance === null ? '—' : balance}<small> NEAR</small></strong><p>Available to transfer: {available === null ? '—' : `${available} NEAR`}</p></div>
            <div className="account-overview-side"><div><span>Multisig address</span><div className="address-copy-line"><code>{treasury.daoId}</code><CopyButton value={treasury.daoId} label="multisig address"/></div><a href={`https://testnet.nearblocks.io/address/${treasury.daoId}`} target="_blank" rel="noreferrer">View on explorer ↗</a></div><div><span>Approval threshold</span><strong>2 / 2</strong></div></div>
          </section>
          {!demoMode && <section className="protection-section"><div className="section-heading"><div><span className="section-kicker">System status</span><h2>Guardian status</h2></div><button className="text-link" onClick={() => navigate('policy')}>View review policy →</button></div><div className="protection-grid"><div className="protection-item"><span className={`status-indicator ${council?.ok ? 'good' : 'warn'}`}>{council?.ok ? '✓' : '!'}</span><div><b>{council?.ok ? '2-of-2 setup verified' : 'Waiting for 2-of-2 verification'}</b><small>Owner and Guardian each have one vote</small></div></div><div className="protection-item"><span className={`status-indicator ${guardianStatus?.council.ok && guardianStatus?.signer?.ready !== false ? 'good' : 'warn'}`}>{guardianStatus?.council.ok && guardianStatus?.signer?.ready !== false ? '✓' : '!'}</span><div><b>{guardianStatus?.council.ok ? 'Guardian connected' : 'Guardian not connected'}</b><small>{guardianStatus?.signer?.ready === false ? guardianStatus.signer.reason : guardianStatus?.ai?.ready ? `Review model: ${guardianStatus.ai.model}` : 'Check the local .env and Guardian terminal'}</small></div><button className="subtle-link" onClick={() => { void checkService(); void loadGuardian(); }}>Refresh</button></div></div></section>}
        </>}

        {activeView === 'proposals' && treasury && <>
          {activeProposal ? <>
            <div className="detail-navigation"><button className="back-link" onClick={() => { setIntentProposalId(null); navigate('proposals'); }}>← Back to proposals</button><span>Proposal #{activeProposal.id}</span></div>
            <div className="page-title detail-page-title"><div><h1>{proposalSummary(activeProposal)}</h1><p>{demoMode ? 'Illustrative proposal' : `Proposal #${activeProposal.id}`} · {kindLabel(activeProposal)} · Unverified note: {activeProposal.description || 'None'}</p></div><div className="page-actions">{!demoMode && <button className="secondary" onClick={() => void refreshWorkspace()}>Refresh</button>}<span className={`status-pill ${proposalStatusStyle(activeProposal.status)}`}>{demoMode ? 'Example' : proposalStatusLabel(activeProposal.status)}</span></div></div>
            <div className="proposal-detail-layout">
              <div className="proposal-detail-main proposal-detail">
                <section className="panel transaction-detail"><div className="panel-head"><h2>{demoMode ? 'Example action' : 'On-chain action'}</h2><span className="proposal-number">{demoMode ? 'Illustrative' : `Proposal #${activeProposal.id}`}</span></div><div className="transaction-effect">{proposalSummary(activeProposal)}</div><div className="detail-facts"><div><span>Proposer</span><strong>{activeProposal.proposer}</strong></div>{activeTarget && <div><span>Recipient / target</span><strong className="target-address">{activeTarget}<CopyButton value={activeTarget} label="recipient or target address"/></strong></div>}<div><span>Action type</span><strong>{kindLabel(activeProposal)}</strong></div><div><span>Approvals</span><strong>{Object.keys(activeProposal.votes || {}).length} / 2</strong></div></div><a className="mobile-approval-jump" href="#approval-panel">View approval progress ↓</a></section>
                {demoMode && activeProposal.id === DEMO_PROPOSAL_ID && typeof activeProposal.kind === 'object' && Boolean(activeProposal.kind.Transfer) && <section className="panel demo-detail-evidence"><div className="panel-head"><div><h2>Example review</h2><p>Illustrative proposal and intent comparison. No transaction or model request occurred.</p></div><span className="guardian-verdict blocked">Example review: Rejected</span></div><p className="hint">The example Owner intended to pay vendor.testnet, while the proposed recipient is vend0r.testnet. A live Guardian would send this signed-intent mismatch to the model before voting.</p><AddressComparison expected="vendor.testnet" actual={(activeProposal.kind.Transfer as { receiver_id: string }).receiver_id} expectedLabel="Example intended recipient"/><div className="demo-vote-state"><strong>No Guardian vote in this example</strong><span>Illustrative preview · create a new multisig for a live Testnet result</span></div></section>}
                {!demoMode && <section className="panel review-section"><div className="panel-head"><div><h2>Guardian review</h2><p>Click to assess this proposal. Guardian votes only if the AI approves it.</p></div><button className="secondary" disabled={reviewingId === activeProposal.id || !guardianStatus || activeProposal.status !== 'InProgress' || Boolean(activeProposal.votes?.[treasury.guardianId])} onClick={() => void review(activeProposal.id)}>{reviewingId === activeProposal.id ? 'Reviewing…' : 'Review proposal'}</button></div>
                  {reviews[activeProposal.id]?.aiDecision ? <div className={`review ${reviews[activeProposal.id].decision.verdict.toLowerCase()}`}><b>Review decision: {aiStatusLabel(reviews[activeProposal.id].aiDecision!.status)}</b><span>{reviews[activeProposal.id].aiDecision!.reason}</span><small>Model: {reviews[activeProposal.id].aiDecision!.model}</small>{reviews[activeProposal.id].aiDecision?.status === 'Needs user confirmation' && <div className="confirmation-reason"><label>Why do you approve this action?<textarea value={confirmationReason} maxLength={1000} onChange={event => setConfirmationReason(event.target.value)} placeholder="I independently verified the recipient and amount…" /></label><button className="secondary small" disabled={busy || !confirmationReason.trim() || accountId !== treasury.ownerId || activeProposal.status !== 'InProgress'} onClick={() => void signConfirmation(activeProposal)}>Sign confirmation</button></div>}</div> : reviewHistory[activeProposal.id] ? <div className={`review ${reviewHistory[activeProposal.id].status === 'Rejected' || reviewHistory[activeProposal.id].status === 'Blocked' ? 'block' : reviewHistory[activeProposal.id].status === 'Approved' ? 'approve' : 'review'}`}><b>Last decision: {reviewHistory[activeProposal.id].status}</b><span>{reviewHistory[activeProposal.id].reason}</span></div> : activeProposal.votes?.[treasury.guardianId] ? <div className="review-placeholder"><b>Guardian approval recorded on-chain</b><p>The AI decision from that vote is not available in this Guardian process session.</p></div> : reviews[activeProposal.id] ? <div className={`review ${reviews[activeProposal.id].decision.verdict.toLowerCase()}`}><b>{reviews[activeProposal.id].decision.verdict}</b><span>{reviews[activeProposal.id].decision.reasons.join('; ')}</span><small>{reviews[activeProposal.id].decision.facts.join(' · ')}</small></div> : <div className="review-placeholder"><b>{guardianStatus ? 'No decision loaded yet' : 'Review service not connected'}</b><p>{guardianStatus ? 'Review the action stored in this on-chain proposal.' : 'Connect Guardian to review this proposal.'}</p>{!guardianStatus && <button className="text-link" onClick={() => void loadGuardian()}>Retry Guardian connection →</button>}</div>}
                  <ReviewEvidence review={reviews[activeProposal.id]} history={reviewHistory[activeProposal.id]} proposal={activeProposal} guardianId={treasury.guardianId}/>{reviewErrors[activeProposal.id] && <div className="ai-report error" role="alert">Review failed: {reviewErrors[activeProposal.id]} <button className="secondary small" onClick={() => void review(activeProposal.id)}>Retry</button></div>}{reviews[activeProposal.id]?.aiError && <div className="ai-report error">Review unavailable: {reviews[activeProposal.id].aiError}</div>}
                </section>}
                {!demoMode && intentProposalId === activeProposal.id && <section className="panel intent-editor">
                  <h2>Add signed intent</h2>
                  <p>Describe what you meant to do using a trusted source. Guardian signs only after comparing your independent intent with the on-chain proposal.</p>
                  <label>Intended action<select value={intentDraft.action} onChange={event => setIntentDraft(current => ({ ...current, action: event.target.value as IntentDraft['action'] }))}><option value="transfer">Transfer NEAR</option><option value="call">Call a contract</option></select></label>
                  {intentDraft.action === 'transfer'
                    ? <div className="form-row"><label>Intended recipient<input value={intentDraft.receiverId} onChange={event => setIntentDraft(current => ({ ...current, receiverId: event.target.value }))} placeholder="Intended Testnet account"/></label><label>Intended amount (NEAR)<input value={intentDraft.amountNear} onChange={event => setIntentDraft(current => ({ ...current, amountNear: event.target.value }))} placeholder="Intended NEAR amount" inputMode="decimal"/></label></div>
                    : <label>What contract call did you intend?<textarea value={intentDraft.text} maxLength={2000} onChange={event => setIntentDraft(current => ({ ...current, text: event.target.value }))} placeholder="For example: Call get_policy on our multisig to read its current policy. No funds should move or permissions change."/><small>Describe the target, method and important parameters in your own words. Exact JSON is optional.</small></label>}
                  <IntentDraftEvidence proposal={activeProposal} draft={intentDraft}/>
                  <button className="primary" disabled={busy || !guardianStatus || (intentDraft.action === 'call' && intentDraft.text.trim().length < 10)} onClick={() => void signIntent(activeProposal)}>Sign intent and send to Guardian →</button>
                </section>}
                {!demoMode && isNativeNearTransfer(activeProposal) && <ImpactPanel key={`${treasury.daoId}:${activeProposal.id}:${api}`} api={api} proposal={activeProposal} aiStatus={reviews[activeProposal.id]?.aiDecision?.status}/>}
              </div>
              <aside id="approval-panel" className="proposal-detail-aside"><section className="panel signature-panel"><div className="panel-head"><h2>Approval progress</h2><strong>{Object.keys(activeProposal.votes || {}).length} / 2</strong></div><div className="signature-track"><div><span className={activeProposal.votes?.[treasury.ownerId] === 'VoteApprove' ? 'signed' : activeProposal.votes?.[treasury.ownerId] ? 'signed rejected' : ''}>{activeProposal.votes?.[treasury.ownerId] ? activeProposal.votes[treasury.ownerId] === 'VoteApprove' ? '✓' : '×' : '1'}</span><div><b>Owner</b><small>{treasury.ownerId}</small></div><em>{voteLabel(activeProposal.votes?.[treasury.ownerId])}</em></div><div><span className={activeProposal.votes?.[treasury.guardianId] === 'VoteApprove' ? 'signed' : activeProposal.votes?.[treasury.guardianId] ? 'signed rejected' : ''}>{activeProposal.votes?.[treasury.guardianId] ? activeProposal.votes[treasury.guardianId] === 'VoteApprove' ? '✓' : '×' : '2'}</span><div><b>Guardian</b><small>{treasury.guardianId}</small></div><em>{activeProposal.votes?.[treasury.guardianId] ? voteLabel(activeProposal.votes[treasury.guardianId]) : 'Pending review'}</em></div></div><ReviewTimeline proposal={activeProposal} ownerId={treasury.ownerId} guardianId={treasury.guardianId} review={reviews[activeProposal.id]} history={reviewHistory[activeProposal.id]} demoMode={demoMode}/>{!demoMode && <><div className="signature-actions"><button className="primary" disabled={busy || accountId !== treasury.ownerId || activeProposal.status !== 'InProgress'} onClick={() => void prepareVote(activeProposal, 'VoteApprove')}>Approve proposal</button><button className="ghost" disabled={busy || !accountId || activeProposal.status !== 'InProgress'} onClick={() => void prepareVote(activeProposal, 'VoteReject')}>Reject proposal</button></div>{['Transfer', 'FunctionCall'].includes(kindName(activeProposal)) && <button className="subtle-link intent-trigger" disabled={accountId !== treasury.ownerId || activeProposal.status !== 'InProgress'} onClick={() => openIntentEditor(activeProposal.id)}>{intentProposalId === activeProposal.id ? 'Hide signed intent' : 'Add signed intent →'}</button>}</>}</section></aside>
            </div>
          </> : <>
          <div className="page-title"><div><h1>Proposals</h1><p>{demoMode ? 'Illustrative proposal and review decision. No transaction was submitted.' : 'Inspect each on-chain action, review decision, and approval status.'}</p></div><div className="page-actions">{!demoMode && <><button className="secondary" onClick={() => void refreshWorkspace()}>Refresh</button><button className="primary" onClick={() => navigate('new')}>New proposal</button></>}</div></div>
            <div className="section-heading proposal-list-heading"><div><span className="section-kicker">TRANSACTION QUEUE</span><h2>All proposals <span>{proposals.length}</span></h2></div></div>
            <section className="proposal-list-panel">{chainLoading && proposals.length === 0 ? <div className="table-empty"><b>Loading on-chain proposals…</b></div> : chainError && proposals.length === 0 ? <div className="table-empty"><b>Could not load proposals</b><p>Retry the RPC read above.</p></div> : proposals.length === 0 ? <div className="table-empty"><b>No proposals yet</b><p>Proposals appear here after submission.</p>{!demoMode && <button className="secondary" onClick={() => navigate('new')}>New proposal</button>}</div> : <div className="transaction-list queue-list"><div className="transaction-list-head"><span>{demoMode ? 'Example action' : 'On-chain action'}</span><span>Unverified note</span><span>Guardian</span><span>Approvals</span><span>Status</span><span/></div>{proposals.map(proposal => <ProposalRow key={proposal.id} proposal={proposal} guardianId={treasury.guardianId} review={reviews[proposal.id]} history={reviewHistory[proposal.id]} demoMode={demoMode} showStatus onOpen={() => { setIntentProposalId(null); navigate('proposals', proposal.id); }}/>)}</div>}</section>
          </>}
        </>}

        {activeView === 'new' && treasury && <>
          <div className="page-title"><div><h1>New proposal</h1><p>Specify the on-chain action. Review its details after submission.</p></div><button className="secondary" onClick={() => navigate('proposals')}>Back to proposals</button></div>
          <div className="single-form"><section className="panel proposal"><div className="panel-head"><div><h2>Proposal details</h2></div></div>
            <div className="segmented"><button className={proposalType === 'transfer' ? 'active' : ''} onClick={() => setProposalType('transfer')}>NEAR Transfer</button><button className={proposalType === 'call' ? 'active' : ''} onClick={() => setProposalType('call')}>Contract call</button><button className={proposalType === 'member' ? 'active' : ''} onClick={() => setProposalType('member')}>Permission change test</button></div>
            <label>{proposalType === 'transfer' ? 'Recipient account' : proposalType === 'call' ? 'Target contract' : 'Account to add to Council'}<input value={receiver} onChange={event => setReceiver(event.target.value)} placeholder={proposalType === 'transfer' ? 'recipient.testnet' : proposalType === 'call' ? 'contract.testnet' : 'attacker.testnet'}/></label>
            {proposalType === 'transfer' ? <div className="form-row"><label>Amount (NEAR)<input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal"/></label><label>Proposal description<input value={description} onChange={event => setDescription(event.target.value)} placeholder="Testnet payout"/></label></div> : proposalType === 'call' ? <><div className="form-row"><label>Method<input value={methodName} onChange={event => setMethodName(event.target.value)} placeholder="run"/></label><label>Attached deposit (NEAR)<input value={callDeposit} onChange={event => setCallDeposit(event.target.value)} inputMode="decimal"/></label></div><label>Arguments (JSON)<textarea value={jsonArgs} onChange={event => setJsonArgs(event.target.value)}/></label><label>Proposal description<input value={description} onChange={event => setDescription(event.target.value)}/></label></> : <><p className="hint">This test proposal adds a Council member. Review the AI decision and reason after submission.</p><label>Proposal description<input value={description} onChange={event => setDescription(event.target.value)}/></label></>}
            <button className="primary submit-button" disabled={!council?.ok || !accountId || busy} onClick={propose}>Submit on-chain proposal →</button>
          </section></div>
        </>}

        {activeView === 'policy' && treasury && <>
          <div className="page-title"><div><h1>Review policy</h1><p>Set the standard Guardian uses to review proposals. Updates require an Owner signature.</p></div></div>
          <div className="single-form"><section className="panel policy"><div className="panel-head"><div><h2>Current policy</h2></div></div>
            <label>Review standard<select value={policy.mode} onChange={event => savePolicy({ ...policy, mode: event.target.value as GuardianPolicy['mode'] })}><option value="strict">High · Allowlist only</option><option value="relaxed">Moderate · AI assesses exceptions</option><option value="double-confirm">Confirm each · Require Owner confirmation</option></select></label>
            <label className="check-row"><input type="checkbox" checked={policy.requireIntentMatch} onChange={event => savePolicy({ ...policy, requireIntentMatch: event.target.checked })}/>Require a match with Owner-signed intent</label>
            <label>Allowed recipients (one per line)<textarea value={receiverText} onChange={event => { setReceiverText(event.target.value); setPolicyDirty(true); }} onBlur={() => savePolicy({ ...policy, allowedReceivers: receiversFromText(receiverText) })} placeholder="trusted-recipient.testnet"/></label>
            <label>Allowed contract methods (contract.testnet:method per line)<textarea value={contractsText} onChange={event => { setContractsText(event.target.value); setPolicyDirty(true); }} onBlur={() => { try { savePolicy({ ...policy, allowedContracts: contractsFromText(contractsText) }); } catch (error) { setNotice(String(error)); } }} placeholder="trusted-contract.testnet:execute"/></label>
            <div className="form-row"><label>Per-transfer limit (NEAR)<input value={policy.maxTransferNear} onChange={event => savePolicy({ ...policy, maxTransferNear: event.target.value })}/></label><label>24-hour limit (NEAR)<input value={policy.maxDailyNear} onChange={event => savePolicy({ ...policy, maxDailyNear: event.target.value })}/></label></div>
            <p className="hint">{guardianStatus ? policyDirty ? 'You have unapplied changes. Sign with the Owner wallet to save them.' : 'Current policy loaded from Guardian.' : 'Connect Guardian before applying this policy.'}</p><div className="form-actions"><button className="primary" disabled={!guardianStatus || !council?.ok || accountId !== treasury.ownerId || busy} onClick={() => void applyPolicy()}>Sign and save policy</button><button className="secondary" onClick={downloadPolicy}>Download JSON</button></div>
          </section></div>
        </>}

        {activeView === 'treasury' && <>
          <div className="page-title"><div><h1>{treasury ? 'Multisig' : mode === 'import' ? 'Connect existing multisig' : 'Create multisig'}</h1><p>{treasury ? 'View the multisig bound to this local Guardian.' : mode === 'import' ? 'Enter its address, read the Council on-chain, then confirm who is the Owner.' : 'Create a 2-of-2 Testnet multisig with your connected wallet as Owner.'}</p></div>{treasury && <button className="secondary" onClick={() => setShowTreasuryForm(current => !current)}>{showTreasuryForm ? 'Cancel' : 'Reconnect multisig'}</button>}</div>
          {!treasury && <div className="onboarding-demo"><div><b>Just exploring?</b><span>See a blocked proposal first. Browsing the demo needs no wallet; connect one when you want to sign.</span></div><button onClick={onEnterDemo}>View read-only demo →</button></div>}
          {!treasury && !demoMode && <div className={`local-service-status ${serviceCheck?.state || 'unchecked'}`} role="status"><strong>{serviceCheck?.state === 'online' ? 'Local Guardian online' : serviceCheck?.state === 'unfunded' ? 'Fund the new Guardian account' : serviceCheck?.state === 'lowbalance' ? 'Top up Guardian voting balance' : serviceCheck?.state === 'partial' ? 'Local Guardian needs attention' : serviceCheck?.state === 'checking' ? 'Checking local Guardian…' : 'Local Guardian offline'}</strong><span>{serviceCheck?.detail || 'Start npm run dev after filling the private .env.'}</span><button className="text-link" onClick={() => void checkService()}>Refresh status</button></div>}
          {treasury && <div className="treasury-summary"><section className="panel"><div className="panel-head"><div><h2>Current multisig</h2></div><button className="text-link" onClick={() => void refreshWorkspace()}>Refresh</button></div><div className="status-card"><span>Multisig address</span><div className="address-copy-line"><strong>{treasury.daoId}</strong><CopyButton value={treasury.daoId} label="multisig address"/></div><a href={`https://testnet.nearblocks.io/address/${treasury.daoId}`} target="_blank" rel="noreferrer">View on explorer ↗</a></div><div className="treasury-members"><div><span>Owner</span><code>{treasury.ownerId}</code></div><div><span>Guardian co-signer</span><code>{treasury.guardianId}</code></div></div><div className={`verification ${council?.ok ? 'ok' : 'warn'}`}><span>{council?.ok ? '✓' : '!'}</span><div><b>{council?.ok ? '2-of-2 setup verified' : 'Waiting for 2-of-2 verification'}</b><small>Both approvals are required to execute a proposal</small></div></div></section>
            <section className="panel"><div className="panel-head"><div><h2>Deposit funds</h2></div></div><div className="deposit-amount">{balance === null ? '—' : balance}<small> NEAR</small></div><p className="hint">Send Testnet NEAR from your connected wallet to the multisig.</p><div className="fund-row"><input value={fundAmount} onChange={event => setFundAmount(event.target.value)} aria-label="Funding amount" inputMode="decimal"/><span>NEAR</span><button disabled={!council?.ok || busy || !accountId} onClick={() => void fund()}>Deposit funds →</button></div></section></div>}
          {(!treasury || showTreasuryForm) && <div className={treasury ? 'single-form' : 'setup-layout'}>
            {!treasury && <aside className="setup-guide"><div className="setup-guide-label">Setup</div><ol><li className="current"><span>1</span><div><b>Choose a multisig</b><small>Connect an existing account or create a new multisig</small></div></li><li><span>2</span><div><b>Verify on-chain setup</b><small>Check Owner, Guardian, and the 2-of-2 threshold</small></div></li><li><span>3</span><div><b>Review proposal</b><small>The local service is started with the web app</small></div></li></ol><div className="setup-guide-note"><strong>Current support</strong><span>NEAR Testnet · Sputnik DAO V2 · 2/2</span></div></aside>}
            <section className="panel setup"><div className="panel-head"><div><h2>{treasury ? 'Reconnect multisig' : 'Multisig'}</h2><p className="setup-form-subtitle">{treasury ? 'Verify the DAO and Owner bound to this local Guardian.' : 'Choose a setup path, then enter the on-chain account details.'}</p></div></div>
            <div className="segmented"><button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Create multisig</button><button className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')}>Connect existing multisig</button></div>
            {mode === 'create' && <div className="guardian-deployment"><span>Dedicated co-signer</span><small>This self-hosted Guardian is bound to one Owner and one multisig. Its signing key is stored privately on this machine and stays available after restart.</small></div>}
            {mode === 'create' ? <label>Multisig name <div className="input-suffix"><input value={name} onChange={event => setName(event.target.value)} placeholder="my-multisig"/><span>.sputnik-v2.testnet</span></div></label> : <><label>Multisig address<input value={importId} onChange={event => { setImportId(event.target.value); setDetectedMembers([]); setLookupError(''); }} placeholder="your-dao.sputnik-v2.testnet"/></label><button className="secondary council-lookup" disabled={lookupBusy || !isSputnikDaoId(importId.trim())} onClick={() => void detectCouncil()}>{lookupBusy ? 'Reading Council…' : 'Read Council members'}</button>{lookupError && <p className="inline-error" role="alert">{lookupError}</p>}{detectedMembers.length === 2 && <div className="council-detected"><b>2-of-2 Council found on-chain</b><label>Which member is the Owner?<select value={ownerId} onChange={event => { const owner = event.target.value; setOwnerId(owner); setGuardianId(detectedMembers.find(member => member !== owner) || ''); }}>{detectedMembers.map(member => <option key={member} value={member}>{member}</option>)}</select></label><small>The other member becomes Guardian co-signer. Confirm these roles before opening the workspace.</small></div>}</>}
            {mode === 'create' ? <div className="form-row"><div className="guardian-account-display"><span>Owner · connected wallet</span><div className="address-copy-line"><code>{accountId || 'Connect wallet to continue'}</code></div></div><div className="guardian-account-display"><span>Guardian co-signer account</span><div className="address-copy-line"><code>{guardianId || 'Waiting for local Guardian…'}</code>{guardianId && <CopyButton value={guardianId} label="Guardian account"/>}</div></div></div> : detectedMembers.length === 2 ? <p className="detected-guardian">Guardian co-signer: <code>{guardianId}</code></p> : <div className="form-row"><label>Owner account<input value={ownerId} onChange={event => setOwnerId(event.target.value)} placeholder="owner.testnet"/></label><label>Guardian co-signer account<input value={guardianId} onChange={event => setGuardianId(event.target.value)} placeholder="guardian.testnet"/></label></div>}
            {guardianAssignedToAnotherOwner && <p className="inline-error" role="alert">This local Guardian belongs to {serviceCheck?.ownerId}. Connect that Owner wallet to open its multisig. A different Owner needs a separate self-hosted Guardian.</p>}
            {mode === 'create' && (serviceCheck?.state === 'unfunded' || serviceCheck?.state === 'lowbalance') && <div className="guardian-funding"><b>{serviceCheck.state === 'unfunded' ? 'Activate the new Guardian account' : 'Top up Guardian voting balance'}</b><p>Transfer 0.5 Testnet NEAR from the connected Owner wallet. The first transfer creates the account on-chain; the balance covers future Guardian voting fees.</p><button type="button" className="secondary" disabled={busy || walletBusy || !accountId} onClick={() => void fundGuardian()}>{busy ? 'Opening wallet…' : walletBusy ? 'Finish wallet connection first' : 'Fund Guardian · 0.5 NEAR →'}</button>{guardianFundingFeedback && <p className={guardianFundingFeedback.error ? 'inline-error' : 'hint'} role={guardianFundingFeedback.error ? 'alert' : 'status'}>{guardianFundingFeedback.message}</p>}</div>}
            {mode === 'create' && <div className="creation-funding"><label>Initial multisig funding (NEAR)<input value={createDeposit} onChange={event => setCreateDeposit(event.target.value)} inputMode="decimal" min="5" step="0.1"/></label><div className="segmented" role="group" aria-label="Initial funding presets">{['5', '6', '10'].map(value => <button key={value} type="button" className={createDeposit === value ? 'active' : ''} onClick={() => setCreateDeposit(value)}>{value} NEAR</button>)}</div><small>The deployed Sputnik DAO contract needs several NEAR for storage. Start with 5 NEAR; this is separate from the Guardian account's 0.5 NEAR. Any balance not locked for storage remains in the multisig.</small></div>}
            <p className="hint">{mode === 'import' ? 'This PoC verifies the Council and 2-of-2 threshold on-chain.' : 'Fund the new Guardian account first, then your wallet creates and funds the multisig separately.'}</p><button className="primary submit-button" disabled={busy || lookupBusy || guardianAssignedToAnotherOwner || (mode === 'create' && (!accountId || !name.trim() || serviceCheck?.state !== 'online' || Boolean(serviceCheck?.daoId))) || (mode === 'import' && (!isSputnikDaoId(importId.trim()) || !isTestnetAccount(ownerId) || !isTestnetAccount(guardianId) || ownerId === guardianId))} onClick={() => void createOrImport()}>{mode === 'create' ? 'Create and verify multisig →' : 'Verify and open workspace →'}</button>
          </section></div>}
        </>}
        {voteConfirmation && <div className="vote-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) setVoteConfirmation(null); }}>
          <section className="vote-dialog" role="dialog" aria-modal="true" aria-labelledby="vote-dialog-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) setVoteConfirmation(null); }}>
            <span className="vote-dialog-kicker">Before you sign · NEAR Testnet</span>
            <h2 id="vote-dialog-title">{voteConfirmation.action === 'VoteApprove' ? 'Approve this on-chain action?' : 'Reject this proposal?'}</h2>
            <p>Proposal #{voteConfirmation.proposal.id} · {voteConfirmation.action === 'VoteApprove' ? 'Your Council approval' : 'Your Council rejection'}</p>
            <div className="vote-action-summary"><span>On-chain action</span><strong>{proposalSummary(voteConfirmation.proposal)}</strong><small>Unverified note: {voteConfirmation.proposal.description || 'None'}</small></div>
            <details><summary>Inspect exact proposal fields</summary><pre>{JSON.stringify(voteConfirmation.proposal.kind, null, 2)}</pre></details>
            {voteConfirmation.action === 'VoteApprove' && <div className={`vote-execution-note ${voteConfirmation.proposal.votes?.[treasury?.guardianId || ''] ? 'immediate' : ''}`}><strong>{voteConfirmation.proposal.votes?.[treasury?.guardianId || ''] ? 'This is the second vote. Approval will execute the proposal immediately.' : 'Guardian approval is still required.'}</strong><span>{voteConfirmation.proposal.votes?.[treasury?.guardianId || ''] ? 'Check the recipient, amount and contract call before opening your wallet.' : 'The Guardian may vote while your wallet is open. Whichever approval lands second can execute the proposal.'}</span></div>}
            <div className="vote-dialog-actions"><button className="secondary" autoFocus disabled={busy} onClick={() => setVoteConfirmation(null)}>Cancel</button><button className={voteConfirmation.action === 'VoteApprove' ? 'primary' : 'ghost'} disabled={busy} onClick={() => void vote(voteConfirmation.proposal, voteConfirmation.action, voteConfirmation.daoId)}>{busy ? 'Submitting…' : voteConfirmation.action === 'VoteApprove' ? 'Confirm and open wallet' : 'Confirm rejection'}</button></div>
          </section>
        </div>}
      </main>
    </div>
  </div>;
}

function currentPage(pathname: string): 'home' | 'app' | 'demo' { return pathname === '/demo' ? 'demo' : pathname === '/app' || pathname.startsWith('/app/') ? 'app' : 'home'; }
export function publicPath(pathname: string, enabled = PUBLIC_DEMO): string {
  const isReadOnlyWorkspace = pathname === '/app/demo' || pathname.startsWith('/app/demo/');
  return enabled && currentPage(pathname) === 'app' && !isReadOnlyWorkspace ? `/app/demo/proposals/${DEMO_PROPOSAL_ID}` : pathname;
}
function initialPath(): string {
  const path = publicPath(window.location.pathname);
  if (path !== window.location.pathname) window.history.replaceState({}, '', path);
  return path;
}

export function App() {
  const [pathname, setPathname] = useState(initialPath);
  useEffect(() => {
    const onRouteChange = () => setPathname(initialPath());
    window.addEventListener('popstate', onRouteChange);
    return () => window.removeEventListener('popstate', onRouteChange);
  }, []);

  function route(path: string) {
    const next = publicPath(path);
    window.history.pushState({}, '', next);
    document.documentElement.scrollTop = 0;
    setPathname(next);
  }
  const page = currentPage(pathname);
  return page === 'demo'
    ? <DemoPage publicDemo={PUBLIC_DEMO} onHome={() => route('/')} onExplore={() => route(`/app/demo/proposals/${DEMO_PROPOSAL_ID}`)} onOpenApp={() => route('/app')}/>
    : page === 'app'
      ? <WorkspaceApp key={pathname.startsWith('/app/demo') ? 'demo' : 'app'} demoMode={pathname.startsWith('/app/demo')} publicDemo={PUBLIC_DEMO} onHome={() => route('/')} onOpenApp={() => route('/app')} onEnterDemo={() => route('/demo')}/>
      : <LandingPage publicDemo={PUBLIC_DEMO} onEnterWorkspace={() => route('/app')} onEnterDemo={() => route('/demo')}/>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App/>);
