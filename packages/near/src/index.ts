import { isTestnetAccount, makeTwoOfTwoPolicy, nearToYocto, type Proposal, type SputnikPolicy } from '@guardian/core';
export { verifyOwnerEnvelope } from './nep413';

export const FACTORY_ID = 'sputnik-v2.testnet';
export const DEFAULT_RPC = 'https://near-testnet.drpc.org';
export function isSputnikDaoId(input: string): boolean {
  return isTestnetAccount(input) && input.endsWith(`.${FACTORY_ID}`) && input !== FACTORY_ID;
}

function base64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export function daoIdFromName(name: string): string {
  if (!/^[a-z0-9_-]{2,32}$/.test(name)) throw new Error('DAO name must be 2–32 lowercase letters, digits, _ or -');
  return `${name}.${FACTORY_ID}`;
}

export function createDaoArgs(name: string, owner: string, guardian: string): { name: string; args: string } {
  daoIdFromName(name);
  const body = {
    config: { name: `Guardian ${name}`, purpose: 'Testnet treasury protected by a 2-of-2 owner and Guardian council.', metadata: '' },
    policy: makeTwoOfTwoPolicy(owner, guardian),
  };
  return { name, args: base64(new TextEncoder().encode(JSON.stringify(body))) };
}

export function transferProposal(receiverId: string, amountNear: string, description: string) {
  if (!isTestnetAccount(receiverId)) throw new Error('Receiver must be a testnet account');
  if (!description.trim()) throw new Error('Description is required');
  const amount = nearToYocto(amountNear);
  if (BigInt(amount) <= 0n) throw new Error('Transfer amount must be positive');
  return { proposal: { description: description.trim(), kind: { Transfer: { token_id: '', receiver_id: receiverId, amount, msg: null } } } };
}

export function functionCallProposal(contractId: string, methodName: string, jsonArgs: string, depositNear: string, description: string) {
  if (!isTestnetAccount(contractId)) throw new Error('Contract must be a testnet account');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(methodName)) throw new Error('Invalid contract method');
  if (!description.trim()) throw new Error('Description is required');
  const args = JSON.parse(jsonArgs) as unknown;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Function arguments must be a JSON object');
  return { proposal: { description: description.trim(), kind: { FunctionCall: {
    receiver_id: contractId,
    actions: [{ method_name: methodName, args: base64(new TextEncoder().encode(JSON.stringify(args))), deposit: nearToYocto(depositNear), gas: '50000000000000' }],
  } } } };
}

export function addCouncilMemberProposal(memberId: string, description: string) {
  if (!isTestnetAccount(memberId)) throw new Error('New council member must be a testnet account');
  if (!description.trim()) throw new Error('Description is required');
  return { proposal: { description: description.trim(), kind: { AddMemberToRole: { member_id: memberId, role: 'council' } } } };
}

export class NearRpc {
  constructor(public readonly url: string = DEFAULT_RPC) {}

  async network(): Promise<string> {
    const response = await fetch(this.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'guardian-network', method: 'status', params: [] }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
    const json = await response.json() as { error?: { message?: string }; result?: { chain_id?: string } };
    if (!json.result?.chain_id) throw new Error(json.error?.message || 'RPC status has no chain ID');
    return json.result.chain_id;
  }

  async query<T>(requestType: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'guardian', method: 'query', params: { request_type: requestType, finality: 'final', ...params } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
    const json = await response.json() as { error?: { message?: string; data?: string }; result?: T };
    if (json.error) throw new Error(json.error.data || json.error.message || 'NEAR RPC error');
    if (!json.result) throw new Error('NEAR RPC returned no result');
    return json.result;
  }

  async view<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!isTestnetAccount(accountId)) throw new Error('Only testnet accounts are supported');
    const result = await this.query<{ result: number[] }>('call_function', { account_id: accountId, method_name: methodName, args_base64: base64(new TextEncoder().encode(JSON.stringify(args))) });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
  }

  async balance(accountId: string): Promise<string> {
    if (!isTestnetAccount(accountId)) throw new Error('Only testnet accounts are supported');
    const result = await this.query<{ amount: string }>('view_account', { account_id: accountId });
    return result.amount;
  }

  getPolicy(daoId: string) { return this.view<SputnikPolicy>(daoId, 'get_policy'); }
  getAvailableAmount(daoId: string) { return this.view<string>(daoId, 'get_available_amount'); }
  getProposal(daoId: string, id: number) { return this.view<Proposal>(daoId, 'get_proposal', { id }).then(p => ({ ...p, id })); }
  getLastProposalId(daoId: string) { return this.view<number>(daoId, 'get_last_proposal_id'); }

  async getRecentProposals(daoId: string, limit = 20): Promise<Proposal[]> {
    const last = await this.getLastProposalId(daoId);
    const from = Math.max(0, last - limit);
    const result = await this.view<Proposal[]>(daoId, 'get_proposals', { from_index: from, limit });
    return result.reverse();
  }
}

export { base64, decodeBase64 };
