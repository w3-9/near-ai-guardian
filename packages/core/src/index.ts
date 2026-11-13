export type Mode = 'strict' | 'relaxed' | 'double-confirm';

export interface GuardianPolicy {
  mode: Mode;
  allowedReceivers: string[];
  allowedContracts: Record<string, string[]>;
  maxTransferNear: string;
  maxDailyNear: string;
  requireIntentMatch: boolean;
}

export interface SputnikPolicy {
  roles: Array<{ name: string; kind: 'Everyone' | { Group: string[] }; permissions: string[]; vote_policy: Record<string, unknown> }>;
  default_vote_policy: { weight_kind: string; quorum: string; threshold: string | number[] };
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
}

export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown> | string;
  status: string;
  votes: Record<string, string>;
  submission_time: string;
}

export interface TransferIntent {
  daoId: string;
  proposalId: number;
  proposer: string;
  receiverId: string;
  tokenId: string;
  amount: string;
}

export interface FunctionCallIntent {
  daoId: string;
  proposalId: number;
  proposer: string;
  kind: Proposal['kind'];
}

export interface NarrativeCallIntent {
  daoId: string;
  proposalId: number;
  proposer: string;
  action: 'call';
  text: string;
}

export type ProposalIntent = TransferIntent | FunctionCallIntent | NarrativeCallIntent;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sameProposalKind(a: Proposal['kind'], b: Proposal['kind']): boolean { return canonical(a) === canonical(b); }

export interface SignedIntentEnvelope {
  message: string;
  nonce: string;
  callbackUrl: string;
  accountId: string;
  publicKey: string;
  signature: string;
}

export type Decision = { verdict: 'APPROVE' | 'BLOCK' | 'REVIEW'; reasons: string[]; facts: string[] };

export const YOCTO = 10n ** 24n;
export const DEFAULT_POLICY: GuardianPolicy = {
  mode: 'strict', allowedReceivers: [], allowedContracts: {},
  maxTransferNear: '1', maxDailyNear: '5', requireIntentMatch: true,
};

export function validateGuardianPolicy(value: unknown): GuardianPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Policy must be an object');
  const p = value as Record<string, unknown>;
  if (!['strict', 'relaxed', 'double-confirm'].includes(String(p.mode))) throw new Error('Invalid policy mode');
  if (!Array.isArray(p.allowedReceivers) || !p.allowedReceivers.every(item => typeof item === 'string' && isTestnetAccount(item))) throw new Error('Invalid receiver allowlist');
  if (!p.allowedContracts || typeof p.allowedContracts !== 'object' || Array.isArray(p.allowedContracts)) throw new Error('Invalid contract allowlist');
  for (const [contract, methods] of Object.entries(p.allowedContracts)) {
    if (!isTestnetAccount(contract) || !Array.isArray(methods) || !methods.every(method => typeof method === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(method))) throw new Error(`Invalid allowlist for ${contract}`);
  }
  if (typeof p.maxTransferNear !== 'string' || typeof p.maxDailyNear !== 'string' || BigInt(nearToYocto(p.maxTransferNear)) <= 0n || BigInt(nearToYocto(p.maxDailyNear)) <= 0n) throw new Error('Invalid transfer limits');
  if (typeof p.requireIntentMatch !== 'boolean') throw new Error('Invalid intent requirement');
  return {
    mode: p.mode as Mode,
    allowedReceivers: [...new Set(p.allowedReceivers as string[])],
    allowedContracts: p.allowedContracts as Record<string, string[]>,
    maxTransferNear: p.maxTransferNear,
    maxDailyNear: p.maxDailyNear,
    requireIntentMatch: p.requireIntentMatch,
  };
}

export function nearToYocto(input: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(input)) throw new Error('NEAR amount must be a nonnegative decimal with at most 24 places');
  const [whole, fraction = ''] = input.split('.');
  return (BigInt(whole) * YOCTO + BigInt((fraction + '0'.repeat(24)).slice(0, 24))).toString();
}

export function yoctoToNear(input: string): string {
  const value = BigInt(input);
  const whole = value / YOCTO;
  const fraction = (value % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function isTestnetAccount(input: string): boolean {
  return /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/.test(input) || /^[0-9a-f]{64}$/.test(input);
}

export function makeTwoOfTwoPolicy(owner: string, guardian: string): SputnikPolicy {
  if (!isTestnetAccount(owner) || !isTestnetAccount(guardian) || owner === guardian) throw new Error('Two distinct testnet accounts are required');
  return {
    roles: [
      { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
      { name: 'council', kind: { Group: [owner, guardian] }, permissions: ['*:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
    proposal_bond: nearToYocto('1'),
    proposal_period: '604800000000000',
    bounty_bond: nearToYocto('1'),
    bounty_forgiveness_period: '86400000000000',
  };
}

export function verifyTwoOfTwo(policy: SputnikPolicy, owner: string, guardian: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!isTestnetAccount(owner) || !isTestnetAccount(guardian) || owner === guardian) reasons.push('Owner and Guardian must be distinct Testnet accounts');
  if (policy.roles.length !== 2 || new Set(policy.roles.map(role => role.name)).size !== 2 || !policy.roles.some(role => role.name === 'all')) reasons.push('Only the all and council roles are supported');
  const council = policy.roles.find(role => role.name === 'council');
  const members = council && typeof council.kind === 'object' ? council.kind.Group : [];
  if (!members || members.length !== 2 || new Set(members).size !== 2 || !members.includes(owner) || !members.includes(guardian)) reasons.push('Council must contain exactly the owner and guardian');
  if (policy.default_vote_policy.weight_kind !== 'RoleWeight' || policy.default_vote_policy.threshold !== '2') reasons.push('Default vote threshold must be fixed at 2');
  if (!council?.permissions.includes('*:VoteApprove')) reasons.push('Council must be able to approve');
  if (council && Object.keys(council.vote_policy).length !== 0) reasons.push('Council has proposal-specific voting overrides');
  for (const role of policy.roles) {
    if (role.name !== 'council' && role.permissions.some(permission => permission.endsWith(':VoteApprove') || permission === '*:*')) reasons.push(`Other role ${role.name} can approve`);
  }
  return { ok: reasons.length === 0, reasons };
}

