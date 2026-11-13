import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, isTestnetAccount, makeTwoOfTwoPolicy, sameProposalKind, validateGuardianPolicy, verifyTwoOfTwo } from './index';

describe('Treasury invariants', () => {
  it('accepts a NEAR implicit account as a Guardian council member', () => {
    const implicit = 'a'.repeat(64);
    expect(isTestnetAccount(implicit)).toBe(true);
    expect(verifyTwoOfTwo(makeTwoOfTwoPolicy('owner.testnet', implicit), 'owner.testnet', implicit).ok).toBe(true);
  });
  it('requires the exact Owner and Guardian in a fixed 2 of 2 council', () => {
    const owner = 'alice.testnet';
    const guardian = 'guardian.testnet';
    const two = makeTwoOfTwoPolicy(owner, guardian);
    expect(verifyTwoOfTwo(two, owner, guardian).ok).toBe(true);
    expect(verifyTwoOfTwo(two, owner, owner).ok).toBe(false);
    expect(verifyTwoOfTwo({ ...two, roles: two.roles.map(role => role.name === 'council' ? { ...role, kind: { Group: [owner, owner] } } : role) }, owner, guardian).ok).toBe(false);
    expect(verifyTwoOfTwo({ ...two, default_vote_policy: { ...two.default_vote_policy, threshold: [1, 2] } }, owner, guardian).ok).toBe(false);
    expect(verifyTwoOfTwo(two, owner, 'attacker.testnet').ok).toBe(false);
  });

  it('binds separately signed intent and confirmation to exact on-chain action fields', () => {
    const expected = { Transfer: { receiver_id: 'trusted.testnet', amount: '1', token_id: '' } };
    expect(sameProposalKind(expected, { Transfer: { token_id: '', amount: '1', receiver_id: 'trusted.testnet' } })).toBe(true);
    expect(sameProposalKind(expected, { Transfer: { receiver_id: 'attacker.testnet', amount: '1', token_id: '' } })).toBe(false);
  });

  it('validates the Owner policy supplied to AI', () => {
    expect(validateGuardianPolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    expect(() => validateGuardianPolicy({ ...DEFAULT_POLICY, allowedReceivers: ['invalid-address'] })).toThrow();
  });
});
