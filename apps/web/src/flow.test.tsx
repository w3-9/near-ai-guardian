// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KeyPair } from 'near-api-js';
import { makeTwoOfTwoPolicy, nearToYocto, type Proposal, type SputnikPolicy } from '@guardian/core';

const data = vi.hoisted(() => ({
  daoId: 'flowui.sputnik-v2.testnet',
  ownerId: 'owner.testnet',
  guardianId: 'guardian.testnet',
  proposals: [] as Proposal[],
  transactions: [] as Array<{ receiverId: string; actions: Array<{ method: string; args: Record<string, unknown> }> }>,
  batchTransactions: 0,
  walletSendError: '',
  signed: [] as string[],
  posts: [] as string[],
  policyFailures: 0,
  policyOverride: null as SputnikPolicy | null,
  aiNeedsConfirmation: false,
  aiRejected: false,
  intentMismatch: false,
  confirmed: false,
  aiTested: false,
  signerKey: null as KeyPair | null,
  guardianUnfunded: false,
  guardianBound: true,
  backendOwnerId: '',
  guardianBalanceNear: '10',
  impactFetchFails: false,
  walletConnected: true,
  walletSubscribers: [] as Array<() => void>,
  selectedWalletId: '',
}));

vi.mock('@near-wallet-selector/core', () => ({
  actionCreators: {
    functionCall: (method: string, args: Record<string, unknown>, _gas?: bigint, deposit?: bigint) => ({ method, args, deposit: deposit?.toString() }),
    transfer: (amount: bigint) => ({ method: 'transfer', args: { amount: String(amount) } }),
  },
  setupWalletSelector: async () => ({
    store: { getState: () => ({ accounts: data.walletConnected ? [{ accountId: data.ownerId, active: true }] : [], selectedWalletId: data.selectedWalletId }), observable: { subscribe: (update: () => void) => { data.walletSubscribers.push(update); return { unsubscribe() { data.walletSubscribers = data.walletSubscribers.filter(item => item !== update); } }; } } },
    wallet: async (id?: string) => {
      const recordTransaction = async (transaction: { receiverId: string; actions: Array<{ method: string; args: Record<string, unknown> }> }) => {
        if (data.walletSendError) throw new Error(data.walletSendError);
        data.transactions.push(transaction);
        const action = transaction.actions[0];
        if (action.method === 'transfer' && transaction.receiverId === data.guardianId) { data.guardianUnfunded = false; data.guardianBalanceNear = '0.5'; }
        if (action.method === 'add_proposal') {
          const input = action.args.proposal as { description: string; kind: Record<string, unknown> };
          data.proposals.unshift({ id: data.proposals.length, proposer: data.ownerId, description: input.description, kind: input.kind, status: 'InProgress', votes: {}, submission_time: '0' });
        }
        return { status: { SuccessValue: '' } };
      };
      return {
      signIn: async () => { data.selectedWalletId = id || ''; data.walletConnected = true; data.walletSubscribers.forEach(update => update()); return [{ accountId: data.ownerId }]; },
      signOut: async () => { data.walletConnected = false; data.walletSubscribers.forEach(update => update()); },
      signAndSendTransaction: recordTransaction,
      signAndSendTransactions: async ({ transactions }: { transactions: Array<{ receiverId: string; actions: Array<{ method: string; args: Record<string, unknown> }> }> }) => { data.batchTransactions += 1; return Promise.all(transactions.map(recordTransaction)); },
      signMessage: async ({ message }: { message: string }) => { data.signed.push(message); return { accountId: data.ownerId, publicKey: 'ed25519:fixture', signature: 'fixture' }; },
    }; },
  }),
}));
vi.mock('@near-wallet-selector/meteor-wallet', () => ({ setupMeteorWallet: () => ({}) }));
vi.mock('@near-wallet-selector/nightly', () => ({ setupNightly: () => ({}) }));
vi.mock('@guardian/near', async importOriginal => {
  const actual = await importOriginal<typeof import('@guardian/near')>();
  return { ...actual, NearRpc: class {
    balance = async (accountId: string) => nearToYocto(accountId === data.guardianId ? data.guardianBalanceNear : '10');
    getAvailableAmount = async () => nearToYocto('8');
    getPolicy = async () => {
      if (data.policyFailures-- > 0) throw new Error('DAO receipt is not final yet');
      return data.policyOverride || makeTwoOfTwoPolicy(data.ownerId, data.guardianId);
    };
    getRecentProposals = async () => [...data.proposals];
    getProposal = async (_daoId: string, id: number) => data.proposals.find(proposal => proposal.id === id)!;
    query = async () => ({ keys: [{ public_key: data.signerKey!.getPublicKey().toString() }] });
  } };
});

import { App, publicPath } from './main';

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState({}, '', '/app');
  data.proposals = []; data.transactions = []; data.batchTransactions = 0; data.walletSendError = ''; data.signed = []; data.posts = []; data.policyFailures = 0; data.policyOverride = null; data.aiNeedsConfirmation = false; data.aiRejected = false; data.intentMismatch = false; data.confirmed = false; data.aiTested = false;
  data.ownerId = 'owner.testnet'; data.walletConnected = true; data.walletSubscribers = []; data.selectedWalletId = ''; data.guardianId = 'guardian.testnet'; data.guardianUnfunded = false; data.guardianBound = true; data.backendOwnerId = ''; data.guardianBalanceNear = '10'; data.impactFetchFails = false;
  data.signerKey = KeyPair.fromRandom('ed25519');
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(1), randomUUID: () => 'callback-state' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    data.posts.push(`${init?.method || 'GET'} ${url}`);
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ ok: true, daoId: data.guardianBound ? data.daoId : '', ownerId: data.guardianBound ? data.backendOwnerId || data.ownerId : '', guardianId: data.guardianId, signerConfigured: true }) };
    if (url.includes('/signer-status?')) {
      const challenge = Uint8Array.from(Buffer.from(new URL(url).searchParams.get('challenge') || '', 'base64'));
      return { ok: true, json: async () => ({ daoId: data.guardianBound ? data.daoId : '', ownerId: data.guardianBound ? data.backendOwnerId || data.ownerId : '', guardianId: data.guardianId, publicKey: data.signerKey!.getPublicKey().toString(), signature: Buffer.from(data.signerKey!.sign(challenge).signature).toString('base64'), accountExists: !data.guardianUnfunded }) };
    }
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId, policy: { mode: 'strict', allowedReceivers: ['trusted.testnet'], allowedContracts: {}, maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true }, council: { ok: true, reasons: [] }, autoApprove: data.aiTested, ai: { configured: data.aiTested, ready: data.aiTested, endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model' } }) };
    if (url.includes('/impact/')) {
      if (data.impactFetchFails) throw new TypeError('Failed to fetch');
      const id = Number(url.split('/').at(-1));
      if (data.proposals.find(proposal => proposal.id === id)?.kind && 'FunctionCall' in (data.proposals.find(proposal => proposal.id === id)?.kind as Record<string, unknown>)) return { ok: true, json: async () => ({ type: 'unavailable', reason: 'Contract calls require a sandbox replay.' }) };
      return { ok: true, json: async () => ({ type: 'balance-projection', amountNear: '0.1', executableFromAvailableBalance: true, accounts: [
      { accountId: data.daoId, beforeNear: '10', afterNear: '9.9', deltaNear: '-0.1' },
      { accountId: 'trusted.testnet', beforeNear: '2', afterNear: '2.1', deltaNear: '+0.1' },
      ] }) };
    }
    if (url.endsWith('/policy')) return { ok: true, json: async () => ({ ok: true }) };
    if (url.endsWith('/bind')) { data.guardianBound = true; return { ok: true, json: async () => ({ ok: true, daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }) }; }
    if (url.endsWith('/confirmation')) { data.confirmed = true; return { ok: true, json: async () => ({ ok: true, proposalId: 0 }) }; }
    if (url.endsWith('/intent')) {
      const envelope = JSON.parse(init?.body || '{}') as { message: string };
      const intent = JSON.parse(envelope.message) as { proposalId: number; receiverId?: string; amount?: string };
      const target = data.proposals.find(item => item.id === intent.proposalId)?.kind as { Transfer?: { receiver_id: string; amount: string } } | undefined;
      const matchesProposal = !target?.Transfer || (intent.receiverId === target.Transfer.receiver_id && intent.amount === target.Transfer.amount);
      data.intentMismatch = !matchesProposal;
      return { ok: true, json: async () => ({ ok: true, proposalId: intent.proposalId, matchesProposal }) };
    }
    if (url.includes('/review/')) {
      const id = Number(url.split('/').at(-1));
      if (data.intentMismatch) return { ok: true, json: async () => ({ decision: { verdict: 'BLOCK', reasons: ['Owner-signed recipient differs from the on-chain recipient'], facts: [] }, policyHash: 'fixture-policy-hash', intent: { receiverId: 'trusted.testnet', amount: nearToYocto('0.1') }, intentComparison: { status: 'mismatch', reason: 'Different recipient' }, aiDecision: { status: 'Rejected', reason: 'Owner-signed recipient differs from the on-chain recipient', model: 'fixture-model' }, spentTodayNear: '0' }) };
      if (data.aiNeedsConfirmation) {
        const status = data.confirmed ? 'Approved' : 'Needs user confirmation';
        return { ok: true, json: async () => ({ decision: { verdict: data.confirmed ? 'APPROVE' : 'REVIEW', reasons: ['请 Owner 确认'], facts: [] }, policyHash: 'fixture-policy-hash', aiDecision: { status, reason: '请 Owner 确认', model: 'fixture-model' }, spentTodayNear: '0' }) };
      }
      if (data.aiRejected) return { ok: true, json: async () => ({ decision: { verdict: 'BLOCK', reasons: ['Recipient differs from trusted address'], facts: [] }, policyHash: 'fixture-policy-hash', aiDecision: { status: 'Rejected', reason: 'Recipient differs from trusted address', model: 'fixture-model' }, spentTodayNear: '0' }) };
      const target = data.proposals.find(item => item.id === id)?.kind as { Transfer?: { receiver_id: string }; FunctionCall?: unknown; AddMemberToRole?: unknown } | undefined;
      return { ok: true, json: async () => ({ decision: { verdict: target?.Transfer?.receiver_id === 'attacker.testnet' || target?.FunctionCall || target?.AddMemberToRole ? 'BLOCK' : 'APPROVE', reasons: ['fixture'], facts: [] }, spentTodayNear: '0' }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openView(label: string) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByText(label));
}

function openProposal(name: RegExp) {
  fireEvent.click(within(document.querySelector('.queue-list') as HTMLElement).getByText(name));
}

describe('browser treasury flow', () => {
  it('restores the bound multisig from Guardian after connecting its Owner wallet', async () => {
    render(<App/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy());
    expect(JSON.parse(localStorage.getItem('guardian-treasury-v2') || '{}')).toEqual({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId });
    expect(data.posts.some(post => post.endsWith('/health'))).toBe(true);
    expect(screen.getByText(data.daoId)).toBeTruthy();
  });
  it('offers creation when the local Guardian has no bound multisig', async () => {
    data.guardianBound = false;
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(localStorage.getItem('guardian-treasury-v2')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Create multisig' })).toBeTruthy();
    expect(screen.getByText('Owner · connected wallet').parentElement?.textContent).toContain(data.ownerId);
  });
  it('does not create with a Guardian already bound to another Owner', async () => {
    data.backendOwnerId = 'another-owner.testnet';
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(screen.getByText(/This local Guardian belongs to another-owner.testnet/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'new-vault' } });
    expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('guardian-treasury-v2')).toBeNull();
  });
  it('discards old demo storage and takes the new Owner from the connected wallet', async () => {
    data.guardianBound = false;
    localStorage.setItem('guardian-treasury', JSON.stringify({ daoId: 'legacy.sputnik-v2.testnet', ownerId: 'legacy-owner.testnet', guardianId: 'legacy-guardian.testnet' }));
    localStorage.setItem('guardian-policy', JSON.stringify({ allowedReceivers: ['legacy-recipient.testnet'] }));
    data.ownerId = 'fresh-owner.testnet';
    render(<App/>);
    expect(screen.getByRole('heading', { name: 'Create multisig' })).toBeTruthy();
    expect(localStorage.getItem('guardian-treasury')).toBeNull();
    expect(localStorage.getItem('guardian-policy')).toBeNull();
    await waitFor(() => expect(screen.getByText('Owner · connected wallet').parentElement?.textContent).toContain('fresh-owner.testnet'));
    expect(screen.queryByDisplayValue('legacy-owner.testnet')).toBeNull();
    expect((screen.getByPlaceholderText('my-multisig') as HTMLInputElement).value).toBe('');
  });
  it('routes public Vercel workspace links to the read-only Testnet demo', () => {
    expect(publicPath('/app', true)).toBe('/app/demo/proposals/0');
    expect(publicPath('/app/policy', true)).toBe('/app/demo/proposals/0');
    expect(publicPath('/app/demo/proposals/0', true)).toBe('/app/demo/proposals/0');
    expect(publicPath('/demo', true)).toBe('/demo');
    expect(publicPath('/app', false)).toBe('/app');
  });
  it('offers Meteor and Nightly, connects Meteor, and lets the Owner disconnect', async () => {
    data.walletConnected = false;
    render(<App/>);
    const connect = await screen.findByRole('button', { name: 'Connect wallet' });
    await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
    fireEvent.click(connect);
    const picker = screen.getByRole('group', { name: 'Choose a Testnet wallet' });
    expect(within(picker).getByRole('button', { name: /Nightly Wallet/ })).toBeTruthy();
    fireEvent.click(within(picker).getByRole('button', { name: /Meteor Wallet/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Wallet ' + data.ownerId })).toBeTruthy());
    expect(data.selectedWalletId).toBe('meteor-wallet');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet ' + data.ownerId }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy());
  });
  it('connects Nightly and shows the selected wallet in the account menu', async () => {
    data.walletConnected = false;
    render(<App/>);
    const connect = await screen.findByRole('button', { name: 'Connect wallet' });
    await waitFor(() => expect(connect.hasAttribute('disabled')).toBe(false));
    fireEvent.click(connect);
    fireEvent.click(within(screen.getByRole('group', { name: 'Choose a Testnet wallet' })).getByRole('button', { name: /Nightly Wallet/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Wallet ' + data.ownerId })).toBeTruthy());
    expect(data.selectedWalletId).toBe('nightly');
    fireEvent.click(screen.getByRole('button', { name: 'Wallet ' + data.ownerId }));
    expect(screen.getByText('Connected with Nightly Wallet')).toBeTruthy();
  });
  it('opens a wallet-free demo and keeps the testnet workspace read-only', async () => {
    window.history.replaceState({}, '', '/');
    render(<App/>);
    fireEvent.click(within(document.querySelector('.landing-hero') as HTMLElement).getByRole('button', { name: /Explore a review/ }));
    expect(window.location.pathname).toBe('/demo');
    expect(screen.getByRole('heading', { name: /One changed character/ })).toBeTruthy();
    expect(document.querySelectorAll('.demo-example mark')).toHaveLength(2);
    expect(screen.getByText(/Guardian vote: withheld in this example/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Explore the workspace preview/ }));
    expect(window.location.pathname).toBe('/app/demo/proposals/0');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Send 0.1 NEAR to vend0r.testnet' })).toBeTruthy());
    expect(screen.getByText('Example review: Rejected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve proposal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull();
  });

  it('restores the read-only workspace when browser navigation crosses demo and app', async () => {
    data.guardianBound = false;
    window.history.replaceState({}, '', '/demo');
    render(<App/>);
    fireEvent.click(screen.getByRole('button', { name: /Explore the workspace preview/ }));
    await waitFor(() => expect(screen.getByText('Example review: Rejected')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    expect(screen.getByRole('heading', { name: 'Create multisig' })).toBeTruthy();
    window.history.replaceState({}, '', '/app/demo/proposals/0');
    fireEvent.popState(window);
    await waitFor(() => expect(screen.getByText('Example review: Rejected')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve proposal' })).toBeNull();
  });

  it('keeps the product introduction separate from multisig setup', () => {
    data.guardianBound = false;
    window.history.replaceState({}, '', '/');
    render(<App/>);
    expect(screen.getByRole('heading', { name: /Sign the action.*you intended/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lookalike address' })).toBeTruthy();
    expect(screen.getByText('~$1.47B')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bybit' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Florence Finance' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'WBTC poisoning' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('your-dao.sputnik-v2.testnet')).toBeNull();
    fireEvent.click(within(document.querySelector('.landing-hero') as HTMLElement).getByRole('button', { name: /Open app/ }));
    expect(window.location.pathname).toBe('/app');
    expect(screen.getByRole('heading', { name: 'Create multisig' })).toBeTruthy();
    expect(screen.getByPlaceholderText('my-multisig')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'AI Guardian home' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { name: /Sign the action.*you intended/ })).toBeTruthy();
  });

  it('opens a focused overview and keeps forms in their own navigation views', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(screen.getByText(data.daoId)).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('recipient.testnet')).toBeNull();
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).toBeNull();
    openView('New proposal');
    expect(screen.getByPlaceholderText('recipient.testnet')).toBeTruthy();
    openView('Review policy');
    expect(screen.getByPlaceholderText('trusted-recipient.testnet')).toBeTruthy();
    expect(screen.queryByPlaceholderText('recipient.testnet')).toBeNull();
    expect(screen.queryByText('Config')).toBeNull();
  });
  it('opens one selected proposal detail from the queue', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [
      { id: 1, proposer: data.ownerId, description: 'Second payout', kind: { Transfer: { token_id: '', receiver_id: 'second.testnet', amount: nearToYocto('0.2'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' },
      { id: 0, proposer: data.ownerId, description: 'First payout', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' },
    ];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(within(document.querySelector('.queue-list') as HTMLElement).getByText(/Second payout/)).toBeTruthy());
    openProposal(/Second payout/);
    expect(screen.getByRole('heading', { name: 'Send 0.2 NEAR to second.testnet' })).toBeTruthy();
    fireEvent.click(screen.getByText('← Back to proposals'));
    openProposal(/First payout/);
    expect(screen.getByRole('heading', { name: 'Send 0.1 NEAR to trusted.testnet' })).toBeTruthy();
    expect(document.querySelector('.proposal-detail')?.textContent).toContain('trusted.testnet');
  });
  it('refuses to reuse one Guardian signer for another multisig', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.aiRejected = true;
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Routine payout', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(within(document.querySelector('.queue-list') as HTMLElement).getByText(/Routine payout/)).toBeTruthy());
    openProposal(/Routine payout/);
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText(/Review decision:/)).toBeTruthy());
    expect(data.posts.some(post => post.startsWith('POST ') && post.includes('/review/0'))).toBe(true);
    openView('Multisig');
    fireEvent.click(screen.getByText('Reconnect multisig'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing multisig' }));
    fireEvent.change(screen.getByPlaceholderText('your-dao.sputnik-v2.testnet'), { target: { value: 'another.sputnik-v2.testnet' } });
    fireEvent.click(screen.getByText('Verify and open workspace →'));
    await waitFor(() => expect(document.body.textContent).toContain('bound to a different Owner or multisig'));
    expect(localStorage.getItem('guardian-treasury-v2')).toContain(data.daoId);
  });
  it('warns that the Owner vote will execute when Guardian already approved', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Routine payout', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: { [data.guardianId]: 'VoteApprove' }, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(within(document.querySelector('.queue-list') as HTMLElement).getByText(/Routine payout/)).toBeTruthy());
    openProposal(/Routine payout/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('This is the second vote. Approval will execute the proposal immediately.'));
    expect(data.transactions).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));
    expect(data.transactions).toHaveLength(0);
  });
  it('requires a new confirmation if Guardian votes while the Owner dialog is open', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Routine payout', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(within(document.querySelector('.queue-list') as HTMLElement).getByText(/Routine payout/)).toBeTruthy());
    openProposal(/Routine payout/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Guardian approval is still required.'));
    data.proposals[0] = { ...data.proposals[0], votes: { [data.guardianId]: 'VoteApprove' } };
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Confirm and open wallet'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(data.transactions).toHaveLength(0);
    expect(document.body.textContent).toContain('proposal votes changed');
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('This is the second vote. Approval will execute the proposal immediately.'));
  });
  it('refuses a vote if the on-chain Council threshold changes', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Routine payout', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(within(document.querySelector('.queue-list') as HTMLElement).getByText(/Routine payout/)).toBeTruthy());
    openProposal(/Routine payout/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const current = makeTwoOfTwoPolicy(data.ownerId, data.guardianId);
    data.policyOverride = { ...current, default_vote_policy: { ...current.default_vote_policy, threshold: '1' } };
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Confirm and open wallet'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(data.transactions).toHaveLength(0);
    expect(document.body.textContent).toContain('Council changed');
  });
  it('funds a newly generated Guardian account before enabling multisig creation', async () => {
    data.guardianBound = false;
    data.guardianId = Buffer.from(data.signerKey!.getPublicKey().data).toString('hex');
    data.guardianUnfunded = true;
    render(<App/>);
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'flowui' } });
    const fundButton = await screen.findByRole('button', { name: 'Fund Guardian · 0.5 NEAR →' });
    expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((fundButton as HTMLButtonElement).disabled).toBe(false));
    vi.stubGlobal('Buffer', undefined);
    fireEvent.click(fundButton);
    await waitFor(() => expect(data.transactions.some(tx => tx.receiverId === data.guardianId && tx.actions[0].args.amount === nearToYocto('0.5'))).toBe(true));
    expect(globalThis.Buffer).toBeDefined();
    expect(data.batchTransactions).toBe(1);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('shows a Guardian funding failure next to the funding button', async () => {
    data.guardianBound = false;
    data.guardianId = Buffer.from(data.signerKey!.getPublicKey().data).toString('hex');
    data.guardianUnfunded = true;
    data.walletSendError = 'User rejected the transaction';
    render(<App/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Fund Guardian · 0.5 NEAR →' }));
    await waitFor(() => expect(document.querySelector('.guardian-funding [role="alert"]')?.textContent).toContain('User rejected the transaction'));
    expect(data.batchTransactions).toBe(1);
    expect(data.transactions).toHaveLength(0);
  });
  it('requires a Guardian voting balance buffer before creation', async () => {
    data.guardianBound = false;
    data.guardianBalanceNear = '0.02';
    render(<App/>);
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'flowui' } });
    const fundButton = await screen.findByRole('button', { name: 'Fund Guardian · 0.5 NEAR →' });
    expect(screen.getAllByText('Top up Guardian voting balance').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((fundButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(fundButton);
    await waitFor(() => expect(data.transactions.some(tx => tx.receiverId === data.guardianId && tx.actions[0].args.amount === nearToYocto('0.5'))).toBe(true));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('binds a newly created multisig to its generated Guardian with an Owner signature', async () => {
    data.guardianId = Buffer.from(data.signerKey!.getPublicKey().data).toString('hex');
    data.guardianUnfunded = true;
    data.guardianBound = false;
    render(<App/>);
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'flowui' } });
    const fundButton = await screen.findByRole('button', { name: 'Fund Guardian · 0.5 NEAR →' });
    await waitFor(() => expect((fundButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(fundButton);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create and verify multisig →' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create and verify multisig →' }));
    await waitFor(() => expect(data.posts.some(post => post.endsWith('/bind'))).toBe(true));
    expect(JSON.parse(data.signed[0])).toMatchObject({ type: 'near-guardian-bind', daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId });
    expect(data.guardianBound).toBe(true);
    await waitFor(() => expect(localStorage.getItem('guardian-treasury-v2')).toContain(data.daoId));
  });
  it('rejects a creation deposit below the observed DAO storage requirement before opening the wallet', async () => {
    data.guardianBound = false;
    render(<App/>);
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'flowui' } });
    fireEvent.change(screen.getByLabelText('Initial multisig funding (NEAR)'), { target: { value: '1' } });
    const createButton = screen.getByRole('button', { name: 'Create and verify multisig →' });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(document.querySelector('.notice')?.textContent).toContain('at least 5 NEAR'));
    expect(data.transactions).toHaveLength(0);
  });
  it('creates, syncs policy, proposes, signs intent and casts the Owner vote', async () => {
    data.guardianBound = false;
    render(<App/>);
    await waitFor(() => expect(screen.getByText('Owner · connected wallet').parentElement?.textContent).toContain(data.ownerId));
    fireEvent.change(screen.getByPlaceholderText('my-multisig'), { target: { value: 'flowui' } });
    expect((screen.getByLabelText('Initial multisig funding (NEAR)') as HTMLInputElement).value).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: '6 NEAR' }));
    fireEvent.click(screen.getByText('Create and verify multisig →'));
    await waitFor(() => expect(screen.getByText(data.daoId)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Guardian connected')).toBeTruthy());
    expect(data.transactions[0].actions[0].method).toBe('create');
    expect((data.transactions[0].actions[0] as { deposit?: string }).deposit).toBe(nearToYocto('6'));
    openView('Multisig');
    fireEvent.click(screen.getByText('Deposit funds →'));
    await waitFor(() => expect(data.transactions.some(t => t.actions[0].method === 'transfer' && t.receiverId === data.daoId)).toBe(true));
    openView('Review policy');
    fireEvent.change(screen.getByPlaceholderText('trusted-recipient.testnet'), { target: { value: 'trusted.testnet\nsecond.testnet' } });
    fireEvent.click(screen.getByText('Sign and save policy'));
    await waitFor(() => expect(data.posts.some(p => p.endsWith('/policy'))).toBe(true));
    expect(JSON.parse(data.signed[1]).policy.allowedReceivers).toEqual(['trusted.testnet', 'second.testnet']);
    openView('New proposal');
    fireEvent.change(screen.getByPlaceholderText('recipient.testnet'), { target: { value: 'trusted.testnet' } });
    fireEvent.click(screen.getByText('Submit on-chain proposal →'));
    await waitFor(() => expect(screen.getByText(/Testnet payout/)).toBeTruthy());
    openProposal(/Testnet payout/);
    fireEvent.click(screen.getByRole('button', { name: /Add signed intent/ }));
    fireEvent.change(screen.getByPlaceholderText('Intended Testnet account'), { target: { value: 'trusted.testnet' } });
    fireEvent.change(screen.getByPlaceholderText('Intended NEAR amount'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByText('Sign intent and send to Guardian →'));
    await waitFor(() => expect(data.posts.some(p => p.endsWith('/intent'))).toBe(true));
    expect(JSON.parse(data.signed[2]).receiverId).toBe('trusted.testnet');
    fireEvent.click(screen.getByText('Approve proposal'));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Guardian approval is still required'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Confirm and open wallet'));
    await waitFor(() => expect(data.transactions.some(t => t.actions[0].method === 'act_proposal')).toBe(true));
    expect(data.signed).toHaveLength(3);
  });
  it('shows local Guardian status without exposing editable service or AI settings', async () => {
    render(<App/>);
    await waitFor(() => expect(screen.getByText('Local Guardian online')).toBeTruthy());
    expect(screen.queryByText('Config')).toBeNull();
    expect(screen.queryByLabelText('Guardian service URL')).toBeNull();
    expect(screen.queryByLabelText('API Key')).toBeNull();
    expect(data.posts.some(post => post.endsWith('/health'))).toBe(true);
    expect(data.posts.some(post => post.includes('/signer-status?'))).toBe(true);
  });
  it('imports a treasury and shows Guardian blocking a malicious recipient', async () => {
    data.guardianBound = false;
    render(<App/>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing multisig' }));
    await waitFor(() => expect(screen.getByText(data.ownerId)).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Connect existing multisig' })).toBeTruthy();
    expect(screen.getByText('Verify and open workspace →')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('your-dao.sputnik-v2.testnet'), { target: { value: data.daoId } });
    fireEvent.click(screen.getByText('Read Council members'));
    await waitFor(() => expect(screen.getByText('2-of-2 Council found on-chain')).toBeTruthy());
    expect(document.querySelector('.detected-guardian')?.textContent).toContain(data.guardianId);
    fireEvent.click(screen.getByText('Verify and open workspace →'));
    await waitFor(() => expect(screen.getByText('2-of-2 setup verified')).toBeTruthy());
    openView('New proposal');
    fireEvent.change(screen.getByPlaceholderText('recipient.testnet'), { target: { value: 'attacker.testnet' } });
    fireEvent.click(screen.getByText('Submit on-chain proposal →'));
    await waitFor(() => expect(screen.getByText(/Testnet payout/)).toBeTruthy());
    openProposal(/Testnet payout/);
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(document.querySelector('.proposal-detail .review.block')?.textContent).toContain('BLOCK'));
    fireEvent.click(screen.getByRole('button', { name: /Add signed intent/ }));
    fireEvent.change(screen.getByPlaceholderText('Intended Testnet account'), { target: { value: 'trusted.testnet' } });
    fireEvent.change(screen.getByPlaceholderText('Intended NEAR amount'), { target: { value: '0.1' } });
    expect(screen.getByText('Intended and on-chain recipients do not match')).toBeTruthy();
    fireEvent.click(screen.getByText('Sign intent and send to Guardian →'));
    await waitFor(() => expect(document.querySelector('.notice')?.textContent).toContain('Click Review proposal'));
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText('Review decision: Rejected')).toBeTruthy());
    expect(screen.getByText('Signature verified · action mismatch')).toBeTruthy();
    expect(JSON.parse(data.signed[1]).receiverId).toBe('trusted.testnet');
    expect((data.proposals[0].kind as { Transfer: { receiver_id: string } }).Transfer.receiver_id).toBe('attacker.testnet');
  });
  it('lets the Owner sign a contract-call intent even when the on-chain proposal is a transfer', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Call get_policy', kind: { Transfer: { token_id: '', receiver_id: 'test3.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(screen.getByText('Call get_policy')).toBeTruthy());
    openProposal(/Call get_policy/);
    fireEvent.click(screen.getByRole('button', { name: /Add signed intent/ }));
    fireEvent.change(screen.getByLabelText('Intended action'), { target: { value: 'call' } });
    fireEvent.change(screen.getByLabelText(/What contract call did you intend/), { target: { value: `Read the current policy by calling get_policy on ${data.daoId}. No funds should move.` } });
    expect(screen.getByText(/Action type differs: your intent describes a contract call/)).toBeTruthy();
    fireEvent.click(screen.getByText('Sign intent and send to Guardian →'));
    await waitFor(() => expect(data.signed).toHaveLength(1));
    expect(JSON.parse(data.signed[0])).toMatchObject({ type: 'near-guardian-narrative', action: 'call', text: `Read the current policy by calling get_policy on ${data.daoId}. No funds should move.` });
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText('Review decision: Rejected')).toBeTruthy());
  });
  it('shows proposal-specific exposure for a rejected lookalike recipient', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.aiRejected = true;
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Vendor payout', kind: { Transfer: { token_id: '', receiver_id: 'vend0r.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(screen.getByText(/Vendor payout/)).toBeTruthy());
    openProposal(/Vendor payout/);
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText('Review decision: Rejected')).toBeTruthy());
    fireEvent.click(screen.getByText('View balance impact'));
    await waitFor(() => expect(screen.getByText('Potential exposure in this proposal')).toBeTruthy());
    expect(document.querySelector('.exposure-result')?.textContent).toContain('0.1 NEAR');
  });
  it('submits a Council change test proposal and shows a blocked review', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(screen.getByText('2-of-2 setup verified')).toBeTruthy());
    openView('New proposal');
    fireEvent.click(screen.getByText('Permission change test'));
    fireEvent.change(screen.getByPlaceholderText('attacker.testnet'), { target: { value: 'attacker.testnet' } });
    fireEvent.click(screen.getByText('Submit on-chain proposal →'));
    await waitFor(() => expect(screen.getByText(/Testnet payout/)).toBeTruthy());
    openProposal(/Testnet payout/);
    expect(screen.queryByText('Estimated balance impact')).toBeNull();
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(document.querySelector('.proposal-detail .review.block')?.textContent).toContain('BLOCK'));
  });
  it('resumes a created treasury after the wallet redirect and a delayed chain receipt', async () => {
    localStorage.setItem('guardian-pending-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.policyFailures = 1;
    render(<App/>);
    await waitFor(() => expect(screen.getByText('2-of-2 setup verified')).toBeTruthy(), { timeout: 3500 });
    expect(localStorage.getItem('guardian-pending-treasury-v2')).toBeNull();
    expect(JSON.parse(localStorage.getItem('guardian-treasury-v2') || '{}').daoId).toBe(data.daoId);
  });
  it('resumes Owner binding after a redirected DAO creation', async () => {
    data.guardianBound = false;
    localStorage.setItem('guardian-pending-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(data.posts.some(post => post.endsWith('/bind'))).toBe(true));
    expect(JSON.parse(data.signed[0])).toMatchObject({ type: 'near-guardian-bind', daoId: data.daoId });
    await waitFor(() => expect(localStorage.getItem('guardian-pending-treasury-v2')).toBeNull());
  });
  it('rejects importing a DAO whose Council differs from the entered accounts', async () => {
    data.policyOverride = makeTwoOfTwoPolicy(data.ownerId, 'someone-else.testnet');
    render(<App/>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing multisig' }));
    fireEvent.change(screen.getByPlaceholderText('your-dao.sputnik-v2.testnet'), { target: { value: data.daoId } });
    fireEvent.change(screen.getByPlaceholderText('owner.testnet'), { target: { value: data.ownerId } });
    fireEvent.change(screen.getByPlaceholderText('guardian.testnet'), { target: { value: data.guardianId } });
    fireEvent.click(screen.getByText('Verify and open workspace →'));
    await waitFor(() => expect(document.querySelector('.notice')?.textContent).toContain('The on-chain multisig members do not match the entered accounts'));
    expect(localStorage.getItem('guardian-treasury-v2')).toBeNull();
  });
  it('shows the RPC balance projection for a proposal', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Pay', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(screen.getByText(/Pay/)).toBeTruthy());
    openProposal(/Pay/);
    fireEvent.click(screen.getByText('View balance impact'));
    await waitFor(() => expect(screen.getByText('10 → 9.9 NEAR')).toBeTruthy());
  });
  it('explains how to reconnect when the local Guardian impact API is unreachable', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Pay', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    data.impactFetchFails = true;
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(screen.getByText(/Pay/)).toBeTruthy());
    openProposal(/Pay/);
    fireEvent.click(screen.getByText('View balance impact'));
    await waitFor(() => expect(document.querySelector('.impact-error')?.textContent).toContain('Start the full app with npm run dev'));
  });
  it('submits a contract-call proposal, signs its independent intent and hides balance impact', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    render(<App/>);
    await waitFor(() => expect(screen.getByText('2-of-2 setup verified')).toBeTruthy());
    openView('New proposal');
    fireEvent.click(screen.getByText('Contract call'));
    fireEvent.change(screen.getByPlaceholderText('contract.testnet'), { target: { value: 'untrusted.testnet' } });
    fireEvent.change(screen.getByPlaceholderText('run'), { target: { value: 'drain' } });
    fireEvent.change(screen.getByLabelText('Attached deposit (NEAR)'), { target: { value: '0.2' } });
    fireEvent.click(screen.getByText('Submit on-chain proposal →'));
    await waitFor(() => expect(screen.getByText(/Testnet payout/)).toBeTruthy());
    openProposal(/Testnet payout/);
    expect(screen.queryByText('Estimated balance impact')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add signed intent/ }));
    fireEvent.change(screen.getByLabelText(/What contract call did you intend/), { target: { value: 'Call drain on untrusted.testnet with a small 0.2 NEAR attached deposit.' } });
    fireEvent.click(screen.getByText('Sign intent and send to Guardian →'));
    await waitFor(() => expect(data.posts.some(post => post.endsWith('/intent'))).toBe(true));
    expect(JSON.parse(data.signed[0])).toMatchObject({ type: 'near-guardian-narrative', action: 'call', text: 'Call drain on untrusted.testnet with a small 0.2 NEAR attached deposit.' });
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(document.querySelector('.proposal-detail .review.block')?.textContent).toContain('BLOCK'));
    expect(data.posts.some(post => post.includes('/impact/'))).toBe(false);
  });
  it('lets the Owner sign a confirmation and displays the second AI decision', async () => {
    localStorage.setItem('guardian-treasury-v2', JSON.stringify({ daoId: data.daoId, ownerId: data.ownerId, guardianId: data.guardianId }));
    data.aiNeedsConfirmation = true;
    data.proposals = [{ id: 0, proposer: data.ownerId, description: 'Pay', kind: { Transfer: { token_id: '', receiver_id: 'trusted.testnet', amount: nearToYocto('0.1'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' }];
    render(<App/>);
    openView('Proposals');
    await waitFor(() => expect(screen.getByText(/Pay/)).toBeTruthy());
    openProposal(/Pay/);
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText('Review decision: Needs user confirmation')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Why do you approve this action?'), { target: { value: 'I verified the recipient and amount independently' } });
    fireEvent.click(screen.getByText('Sign confirmation'));
    await waitFor(() => expect(data.posts.some(post => post.endsWith('/confirmation'))).toBe(true));
    expect(JSON.parse(data.signed[0])).toMatchObject({ type: 'near-guardian-confirmation', proposalId: 0, policyHash: 'fixture-policy-hash', reason: 'I verified the recipient and amount independently' });
    expect(screen.getByText('Review decision: Needs user confirmation')).toBeTruthy();
    expect(data.posts.filter(post => post.includes('/review/0'))).toHaveLength(1);
    fireEvent.click(screen.getByText('Review proposal'));
    await waitFor(() => expect(screen.getByText('Review decision: Approved')).toBeTruthy());
  });
});
