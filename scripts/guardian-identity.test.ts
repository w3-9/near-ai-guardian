import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGuardianIdentity } from './guardian-identity.mjs';

describe('local Guardian identity', () => {
  it('generates and persists an unbound signer before the web onboarding binds a DAO', () => {
    const folder = mkdtempSync(join(tmpdir(), 'guardian-unbound-'));
    try {
      const path = join(folder, 'identity.local');
      const first = ensureGuardianIdentity(path);
      expect(first.GUARDIAN_DAO_ID).toBe('');
      expect(first.GUARDIAN_OWNER_ID).toBe('');
      expect(first.GUARDIAN_ACCOUNT_ID).toMatch(/^[0-9a-f]{64}$/);
      expect(ensureGuardianIdentity(path).GUARDIAN_PRIVATE_KEY).toBe(first.GUARDIAN_PRIVATE_KEY);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('generates a different persistent signer for each DAO and refuses key reuse', () => {
    const folder = mkdtempSync(join(tmpdir(), 'guardian-identity-'));
    try {
      const firstPath = join(folder, 'first.local');
      const secondPath = join(folder, 'second.local');
      writeFileSync(firstPath, 'GUARDIAN_DAO_ID=first.sputnik-v2.testnet\nGUARDIAN_OWNER_ID=first-owner.testnet\n');
      writeFileSync(secondPath, 'GUARDIAN_DAO_ID=second.sputnik-v2.testnet\nGUARDIAN_OWNER_ID=second-owner.testnet\n');
      const first = ensureGuardianIdentity(firstPath);
      const second = ensureGuardianIdentity(secondPath);
      expect(first.GUARDIAN_ACCOUNT_ID).toMatch(/^[0-9a-f]{64}$/);
      expect(first.GUARDIAN_ACCOUNT_ID).not.toBe(second.GUARDIAN_ACCOUNT_ID);
      expect(ensureGuardianIdentity(firstPath).GUARDIAN_PRIVATE_KEY).toBe(first.GUARDIAN_PRIVATE_KEY);
      writeFileSync(firstPath, readFileSync(firstPath, 'utf8').replace('GUARDIAN_DAO_ID=first.sputnik-v2.testnet', 'GUARDIAN_DAO_ID=other.sputnik-v2.testnet'));
      expect(() => ensureGuardianIdentity(firstPath)).toThrow('belongs to a different DAO');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
