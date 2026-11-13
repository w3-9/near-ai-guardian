import { describe, expect, it, vi } from 'vitest';
import { addCouncilMemberProposal, decodeBase64, createDaoArgs, daoIdFromName, functionCallProposal, isSputnikDaoId, NearRpc, transferProposal } from './index';

describe('Sputnik adapter', () => {
  it('encodes the full 2-of-2 policy in factory creation args', () => {
    const { args } = createDaoArgs('demo', 'alice.testnet', 'guardian.testnet');
    const data = JSON.parse(new TextDecoder().decode(decodeBase64(args)));
    expect(data.policy.default_vote_policy.threshold).toBe('2');
    expect(data.policy.roles[1].kind.Group).toEqual(['alice.testnet', 'guardian.testnet']);
    expect(daoIdFromName('demo')).toBe('demo.sputnik-v2.testnet');
    expect(isSputnikDaoId('demo.sputnik-v2.testnet')).toBe(true);
    expect(isSputnikDaoId('demo.testnet')).toBe(false);
  });
  it('creates exact yoctoNEAR transfer actions and rejects malformed recipients', () => {
    expect(transferProposal('alice.testnet', '0.25', 'pay').proposal.kind.Transfer.amount).toBe('250000000000000000000000');
    expect(() => transferProposal('alice.near', '1', 'pay')).toThrow();
  });
  it('encodes a contract-call proposal for dangerous-call review', () => {
    const call = functionCallProposal('demo-contract.testnet', 'run', '{}', '0', 'Call test').proposal.kind.FunctionCall;
    expect(call.actions[0].args).toBe('e30=');
    expect(call.actions[0].deposit).toBe('0');
  });
  it('builds a council-changing proposal for the blocked governance demo', () => {
    expect(addCouncilMemberProposal('attacker.testnet', 'Add attacker').proposal.kind.AddMemberToRole.role).toBe('council');
  });
  it('decodes the flat Sputnik proposal output returned by testnet RPC', async () => {
    const proposal = { id: 4, proposer: 'alice.testnet', description: 'pay', kind: { Transfer: { token_id: '', receiver_id: 'bob.testnet', amount: '100', msg: null } }, status: 'InProgress', votes: {}, submission_time: '1' };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init.body)) as { params: { method_name: string } };
      const value = body.params.method_name === 'get_last_proposal_id' ? 5 : body.params.method_name === 'get_proposals' ? [proposal] : proposal;
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rpc = new NearRpc('https://fixture.testnet');
      expect((await rpc.getProposal('demo.sputnik-v2.testnet', 4)).kind).toEqual(proposal.kind);
      expect((await rpc.getRecentProposals('demo.sputnik-v2.testnet', 10))[0].id).toBe(4);
    } finally { vi.unstubAllGlobals(); }
  });
});
