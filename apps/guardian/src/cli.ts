import 'dotenv/config';
import { config as loadIdentity, parse as parseEnv } from 'dotenv';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { stdout } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';
import { DEFAULT_POLICY, isTestnetAccount, nearToYocto, sameProposalKind, validateGuardianPolicy, verifyTwoOfTwo, yoctoToNear, type Decision, type GuardianPolicy, type Proposal, type SignedIntentEnvelope, type ProposalIntent } from '@guardian/core';
import { DEFAULT_RPC, isSputnikDaoId, NearRpc, verifyOwnerEnvelope } from '@guardian/near';
import { chatCompletionEndpoint, decideProposal, decisionCacheKey, validateEndpoint, type AiConfig, type AiDecision, type AiEvidence, type IntentComparison } from './ai';
import { collectHistory, type HistoryEvidence } from './history';

loadIdentity({ path: '.guardian-identity.local' });

let daoId = process.env.GUARDIAN_DAO_ID ?? '';
let ownerId = process.env.GUARDIAN_OWNER_ID ?? '';
const guardianId = process.env.GUARDIAN_ACCOUNT_ID ?? '';
const verificationRpcUrl = process.env.NEAR_RPC_URL || DEFAULT_RPC;
let rpc = new NearRpc(verificationRpcUrl);
let aiConfig: AiConfig | null = process.env.GUARDIAN_AI_ENDPOINT && process.env.GUARDIAN_AI_MODEL
  ? { endpoint: process.env.GUARDIAN_AI_ENDPOINT, model: process.env.GUARDIAN_AI_MODEL, apiKey: process.env.GUARDIAN_AI_API_KEY || '' }
  : null;
let aiReady = false;
const intentFile = process.env.GUARDIAN_INTENTS_FILE || './.guardian-intents.json';
const confirmationFile = process.env.GUARDIAN_CONFIRMATIONS_FILE || './.guardian-confirmations.json';
const policyFile = process.env.GUARDIAN_POLICY_FILE || './guardian-policy.json';
let recipient = `near-guardian:${daoId}`;
const identityFile = process.env.GUARDIAN_IDENTITY_FILE || './.guardian-identity.local';
type SavedIntent = { intent: ProposalIntent; envelope: SignedIntentEnvelope; expiresAt: number };
type ConfirmationPayload = { type: 'near-guardian-confirmation'; version: 1; daoId: string; proposalId: number; proposalKind: Proposal['kind']; policyHash: string; reason: string; expiresAt: number };
type BindingPayload = { type: 'near-guardian-bind'; version: 1; daoId: string; ownerId: string; guardianId: string; expiresAt: number };
type SavedConfirmation = { envelope: SignedIntentEnvelope };
type SettingsInput = { nearRpcUrl?: string; aiEndpoint?: string; aiModel?: string; aiApiKey?: string; clearAi?: boolean };
type ReviewSummary = { proposalId: number; status: AiDecision['status'] | 'Blocked' | 'Unavailable'; reason: string; reviewedAt: string; policyHash: string; intentVerified: boolean; intentMatches: boolean | null; history: HistoryEvidence | null; model?: string; guardianVoteTx?: string | null };
const reviewLog = new Map<number, ReviewSummary>();
const uncertainVotes = new Map<number, number>();
function policyHash(value: GuardianPolicy): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function signerReadiness(): Promise<{ ready: boolean; reason: string; balanceNear?: string }> {
  const privateKey = process.env.GUARDIAN_PRIVATE_KEY;
  if (!privateKey) return { ready: false, reason: 'Guardian signing key is missing' };
  try {
    const publicKey = KeyPair.fromString(privateKey as `ed25519:${string}`).getPublicKey().toString();
    const access = await rpc.query<{ keys: Array<{ public_key: string }> }>('view_access_key_list', { account_id: guardianId });
    if (!access.keys.some(item => item.public_key === publicKey)) return { ready: false, reason: 'Guardian key does not match its on-chain account' };
    const balance = await rpc.balance(guardianId);
    const balanceNear = yoctoToNear(balance);
    if (BigInt(balance) < BigInt(nearToYocto('0.1'))) return { ready: false, reason: 'Guardian needs at least 0.1 NEAR left for voting fees', balanceNear };
    return { ready: true, reason: 'Guardian key and voting balance verified', balanceNear };
  } catch { return { ready: false, reason: 'Guardian account or RPC is not ready' }; }
}
export async function signerStatus(challenge: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(challenge)) throw new Error('A 32-byte challenge is required');
  const key = process.env.GUARDIAN_PRIVATE_KEY;
  if (!key) throw new Error('Guardian signing key is not configured');
  const signer = KeyPair.fromString(key as `ed25519:${string}`);
  const publicKey = signer.getPublicKey().toString();
  let accountExists = true;
  let keyMatches = false;
  try {
    await rpc.query('view_account', { account_id: guardianId });
  } catch (error) {
    if (!/does not exist|unknown.?account|account .* not found/i.test(String(error))) throw error;
    accountExists = false;
  }
  if (accountExists) {
    const access = await rpc.query<{ keys: Array<{ public_key: string }> }>('view_access_key_list', { account_id: guardianId });
    keyMatches = access.keys.some(item => item.public_key === publicKey);
  }
  return { daoId, ownerId, guardianId, publicKey, signature: Buffer.from(signer.sign(Buffer.from(challenge, 'base64')).signature).toString('base64'), accountExists, keyMatches };
}
async function withTimeout<T>(operation: Promise<T>, durationMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${durationMs / 1000}s`)), durationMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const MAX_SIGNED_LIFETIME_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
function callbackUrl(): string { return process.env.GUARDIAN_CALLBACK_URL || 'http://127.0.0.1:5173/app'; }
function validSignedExpiry(value: unknown): value is number {
  const now = Date.now();
  return typeof value === 'number' && Number.isSafeInteger(value) && value > now && value <= now + MAX_SIGNED_LIFETIME_MS + CLOCK_SKEW_MS;
}

const pendingFileWrites = new Map<string, Promise<void>>();
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
async function atomicWriteText(file: string, value: string): Promise<void> {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, value, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
async function serializedFileWrite(file: string, task: () => Promise<void>): Promise<void> {
  const previous = pendingFileWrites.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(task);
  pendingFileWrites.set(file, pending);
  try { await pending; }
  finally { if (pendingFileWrites.get(file) === pending) pendingFileWrites.delete(file); }
}
async function updateJsonFile<T>(file: string, load: () => Promise<Record<string, T>>, key: string, value: T): Promise<void> {
  await serializedFileWrite(file, async () => {
    const data = await load();
    data[key] = value;
    await atomicWriteJson(file, data);
  });
}

async function verifyOwnerSignature(input: SignedIntentEnvelope) {
  if (input.accountId !== ownerId) throw new Error('Message must be signed by the configured Owner');
  if (input.callbackUrl !== callbackUrl()) throw new Error('Unexpected callback URL');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.nonce)) throw new Error('Invalid 32-byte nonce');
  await withTimeout(verifyOwnerEnvelope(input, recipient, new JsonRpcProvider({ url: verificationRpcUrl })), 20_000, 'Owner signature verification');
}

export async function bindGuardian(input: SignedIntentEnvelope) {
  const parsed = JSON.parse(input.message) as Partial<BindingPayload>;
  if (parsed.type !== 'near-guardian-bind' || parsed.version !== 1 || !parsed.daoId || !isSputnikDaoId(parsed.daoId) || !parsed.ownerId || !isTestnetAccount(parsed.ownerId) || parsed.guardianId !== guardianId || !validSignedExpiry(parsed.expiresAt)) throw new Error('Invalid or expired Guardian binding');
  if (daoId || ownerId) throw new Error('This Guardian is already bound to one Owner and DAO');
  if (input.accountId !== parsed.ownerId || input.callbackUrl !== callbackUrl() || !/^[A-Za-z0-9+/]{43}=$/.test(input.nonce)) throw new Error('Owner binding signature is invalid');
  await withTimeout(verifyOwnerEnvelope(input, `near-guardian:${parsed.daoId}`, new JsonRpcProvider({ url: verificationRpcUrl })), 20_000, 'Owner binding verification');
  const chainPolicy = await rpc.getPolicy(parsed.daoId);
  const council = verifyTwoOfTwo(chainPolicy, parsed.ownerId, guardianId);
  if (!council.ok) throw new Error(`The on-chain Council differs from this Guardian binding: ${council.reasons.join('; ')}`);
  const signer = await signerReadiness();
  if (!signer.ready) throw new Error(signer.reason);
  await serializedFileWrite(identityFile, async () => {
    const stored = parseEnv(await readFile(identityFile));
    if (stored.GUARDIAN_DAO_ID || stored.GUARDIAN_OWNER_ID || stored.GUARDIAN_ACCOUNT_ID !== guardianId || stored.GUARDIAN_PRIVATE_KEY !== process.env.GUARDIAN_PRIVATE_KEY) throw new Error('Local Guardian identity changed during binding');
    await atomicWriteText(identityFile, `GUARDIAN_DAO_ID=${parsed.daoId}\nGUARDIAN_OWNER_ID=${parsed.ownerId}\nGUARDIAN_ACCOUNT_ID=${guardianId}\nGUARDIAN_PRIVATE_KEY=${stored.GUARDIAN_PRIVATE_KEY}\nGUARDIAN_KEY_DAO_ID=${parsed.daoId}\n`);
  });
  daoId = parsed.daoId;
  ownerId = parsed.ownerId;
  recipient = `near-guardian:${daoId}`;
  process.env.GUARDIAN_DAO_ID = daoId;
  process.env.GUARDIAN_OWNER_ID = ownerId;
  return { ok: true, daoId, ownerId, guardianId };
}

async function intents(): Promise<Record<string, SavedIntent>> {
  try { return JSON.parse(await readFile(intentFile, 'utf8')) as Record<string, SavedIntent>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

async function confirmations(): Promise<Record<string, SavedConfirmation>> {
  try { return JSON.parse(await readFile(confirmationFile, 'utf8')) as Record<string, SavedConfirmation>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

export async function saveIntent(input: SignedIntentEnvelope) {
  const parsed = JSON.parse(input.message) as ProposalIntent & { type?: string; version?: number; expiresAt?: number };
  if (!['near-guardian-transfer', 'near-guardian-call', 'near-guardian-narrative'].includes(parsed.type ?? '') || parsed.version !== 1 || parsed.daoId !== daoId || !Number.isSafeInteger(parsed.proposalId) || !validSignedExpiry(parsed.expiresAt)) throw new Error('Invalid or expired intent payload; check that the browser and Guardian clocks are synchronized');
  await verifyOwnerSignature(input);
  const proposal = await rpc.getProposal(daoId, parsed.proposalId);
  if (parsed.proposer !== proposal.proposer) throw new Error('Signed intent proposer differs from on-chain proposal');
  if (parsed.type === 'near-guardian-transfer') {
    if ('kind' in parsed || 'text' in parsed || !('receiverId' in parsed) || !isTestnetAccount(parsed.receiverId) || parsed.tokenId !== '' || typeof parsed.amount !== 'string' || !/^\d+$/.test(parsed.amount)) throw new Error('Invalid signed transfer intent');
  } else if (parsed.type === 'near-guardian-call') {
    const call = 'kind' in parsed && typeof parsed.kind === 'object' && parsed.kind !== null && !Array.isArray(parsed.kind)
      ? parsed.kind.FunctionCall as { receiver_id?: string; actions?: Array<{ method_name?: string; args?: string; deposit?: string; gas?: string }> } | undefined
      : undefined;
    const action = call?.actions?.[0];
    if ('receiverId' in parsed || 'text' in parsed || !call || Object.keys(parsed.kind).length !== 1 || !isTestnetAccount(call.receiver_id || '') || !Array.isArray(call.actions) || call.actions.length !== 1 || !action || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(action.method_name || '') || typeof action.args !== 'string' || !/^\d+$/.test(action.deposit || '') || !/^\d+$/.test(action.gas || '')) throw new Error('Invalid signed contract-call intent');
  } else if ('kind' in parsed || 'receiverId' in parsed || !('text' in parsed) || parsed.action !== 'call' || typeof parsed.text !== 'string' || parsed.text.trim().length < 10 || parsed.text.length > 2000) {
    throw new Error('Describe the intended contract call in 10–2000 characters');
  }
  const intent: ProposalIntent = 'kind' in parsed
    ? { daoId: parsed.daoId, proposalId: parsed.proposalId, proposer: parsed.proposer, kind: parsed.kind }
    : 'text' in parsed
      ? { daoId: parsed.daoId, proposalId: parsed.proposalId, proposer: parsed.proposer, action: 'call', text: parsed.text.trim() }
      : { daoId: parsed.daoId, proposalId: parsed.proposalId, proposer: parsed.proposer, receiverId: parsed.receiverId, tokenId: parsed.tokenId, amount: parsed.amount };
  await updateJsonFile(intentFile, intents, String(parsed.proposalId), { intent, envelope: input, expiresAt: parsed.expiresAt });
  const comparison = compareSignedIntent(intent, proposal);
  return { ok: true, proposalId: parsed.proposalId, matchesProposal: comparison.status === 'semantic_review' ? null : comparison.status === 'match' };
}

export async function saveConfirmation(input: SignedIntentEnvelope) {
  const parsed = JSON.parse(input.message) as Partial<ConfirmationPayload>;
  if (parsed.type !== 'near-guardian-confirmation' || parsed.version !== 1 || parsed.daoId !== daoId || !Number.isSafeInteger(parsed.proposalId) || typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 1000 || !validSignedExpiry(parsed.expiresAt)) throw new Error('Invalid or expired confirmation; check that the browser and Guardian clocks are synchronized');
  await verifyOwnerSignature(input);
  const proposal = await rpc.getProposal(daoId, parsed.proposalId!);
  if (proposal.status !== 'InProgress' || parsed.proposalKind === undefined || !sameProposalKind(parsed.proposalKind, proposal.kind) || parsed.policyHash !== policyHash(await policy())) throw new Error('Confirmation differs from current proposal or policy');
  const current = reviewLog.get(parsed.proposalId!);
  if (current?.status !== 'Needs user confirmation' || current.policyHash !== parsed.policyHash) throw new Error('Review this proposal first; AI must request Owner confirmation for the current policy');
  await updateJsonFile(confirmationFile, confirmations, String(parsed.proposalId), { envelope: input });
  return { ok: true, proposalId: parsed.proposalId };
}

async function policy(): Promise<GuardianPolicy> {
  return validateGuardianPolicy(JSON.parse(await readFile(policyFile, 'utf8')));
}

export async function savePolicy(input: SignedIntentEnvelope) {
  const parsed = JSON.parse(input.message) as { type?: string; version?: number; daoId?: string; policy?: unknown; expiresAt?: number };
  if (parsed.type !== 'near-guardian-policy' || parsed.version !== 1 || parsed.daoId !== daoId || !validSignedExpiry(parsed.expiresAt)) throw new Error('Invalid or expired policy update; check that the browser and Guardian clocks are synchronized');
  const next = validateGuardianPolicy(parsed.policy);
  await verifyOwnerSignature(input);
  await serializedFileWrite(policyFile, () => atomicWriteJson(policyFile, next));
  await serializedFileWrite(confirmationFile, () => atomicWriteJson(confirmationFile, {}));
  return { ok: true, policy: next };
}

async function spentToday(): Promise<string> {
  const count = await rpc.getLastProposalId(daoId);
  let spent = 0n;
  const start = BigInt(Date.now() - 24 * 60 * 60 * 1000) * 1_000_000n;
  let scanned = 0;
  for (let end = count; end > 0;) {
    const from = Math.max(0, end - 50);
    const page = await rpc.view<Proposal[]>(daoId, 'get_proposals', { from_index: from, limit: end - from });
    let reachedEarlierDay = false;
    for (const proposal of page) {
      if (BigInt(proposal.submission_time) < start) { reachedEarlierDay = true; continue; }
      if (proposal.status !== 'Approved' || typeof proposal.kind !== 'object' || !proposal.kind.Transfer) continue;
      const transfer = proposal.kind.Transfer as { token_id?: string; amount?: string };
      if (transfer.token_id === '' && typeof transfer.amount === 'string') spent += BigInt(transfer.amount);
    }
    if (reachedEarlierDay) break;
    scanned += end - from;
    end = from;
    if (scanned >= 2000 && end > 0) throw new Error('More than 2000 proposals were submitted in the last 24 hours; daily spend cannot be verified');
  }
  return spent.toString();
}

async function addressEvidence(proposal: Proposal, localPolicy: GuardianPolicy): Promise<AiEvidence> {
  const kind = typeof proposal.kind === 'object' ? proposal.kind : {};
  const transfer = kind.Transfer as { receiver_id?: string } | undefined;
  const call = kind.FunctionCall as { receiver_id?: string } | undefined;
  const accountId = transfer?.receiver_id || call?.receiver_id || null;
  if (!accountId || !isTestnetAccount(accountId)) return { accountId, accountExists: null, codeHash: null, allowlisted: false };
  const allowlisted = transfer ? localPolicy.allowedReceivers.includes(accountId) : Boolean(localPolicy.allowedContracts[accountId]?.length);
  try {
    const account = await rpc.query<{ code_hash?: string }>('view_account', { account_id: accountId });
    return { accountId, accountExists: true, codeHash: account.code_hash || null, allowlisted };
  } catch { return { accountId, accountExists: null, codeHash: null, allowlisted }; }
}

function intentMatchesProposal(intent: ProposalIntent, proposal: Proposal): boolean {
  if (intent.daoId !== daoId || intent.proposalId !== proposal.id || intent.proposer !== proposal.proposer || typeof proposal.kind !== 'object') return false;
  if ('text' in intent) return false;
  if ('kind' in intent) return sameProposalKind(intent.kind, proposal.kind);
  const transfer = proposal.kind.Transfer as { receiver_id?: string; token_id?: string; amount?: string } | undefined;
  return Boolean(transfer && intent.receiverId === transfer.receiver_id && intent.tokenId === transfer.token_id && intent.amount === transfer.amount);
}

function compareSignedIntent(intent: ProposalIntent, proposal: Proposal): IntentComparison {
  if ('text' in intent) {
    if (typeof proposal.kind !== 'object' || !proposal.kind.FunctionCall) return { status: 'mismatch', reason: 'action type: Owner described a contract call; on-chain proposal is not a contract call' };
    return { status: 'semantic_review', reason: 'Owner-signed contract-call description requires AI comparison with the on-chain target, method, arguments and deposit' };
  }
  if (intentMatchesProposal(intent, proposal)) return { status: 'match', reason: 'Owner-signed fields match the current on-chain action' };
  const signedKind = 'kind' in intent ? 'contract call' : 'transfer';
  const onchainKind = typeof proposal.kind === 'string' ? proposal.kind : Object.keys(proposal.kind)[0] || 'unknown action';
  if (('kind' in intent && onchainKind !== 'FunctionCall') || (!('kind' in intent) && onchainKind !== 'Transfer')) {
    return { status: 'mismatch', reason: `action type: Owner signed ${signedKind}; on-chain ${onchainKind}` };
  }
  if ('kind' in intent && typeof intent.kind === 'object' && typeof proposal.kind === 'object') {
    const expected = intent.kind.FunctionCall as { receiver_id?: string; actions?: Array<{ method_name?: string; args?: string; deposit?: string; gas?: string }> };
    const actual = proposal.kind.FunctionCall as typeof expected;
    const expectedAction = expected?.actions?.[0];
    const actualAction = actual?.actions?.[0];
    const differences = [
      expected?.receiver_id !== actual?.receiver_id ? `contract: Owner signed ${expected?.receiver_id ?? '?'}; on-chain ${actual?.receiver_id ?? '?'}` : '',
      expectedAction?.method_name !== actualAction?.method_name ? `method: Owner signed ${expectedAction?.method_name ?? '?'}; on-chain ${actualAction?.method_name ?? '?'}` : '',
      expectedAction?.args !== actualAction?.args ? 'arguments differ' : '',
      expectedAction?.deposit !== actualAction?.deposit ? `attached deposit: Owner signed ${expectedAction?.deposit ?? '?'} yoctoNEAR; on-chain ${actualAction?.deposit ?? '?'} yoctoNEAR` : '',
      expectedAction?.gas !== actualAction?.gas ? 'gas allowance differs' : '',
      expected?.actions?.length !== actual?.actions?.length ? 'number of contract actions differs' : '',
    ].filter(Boolean);
    return { status: 'mismatch', reason: differences.join('; ') || 'Owner-signed contract call differs from the current on-chain action' };
  }
  if ('receiverId' in intent && typeof proposal.kind === 'object') {
    const transfer = proposal.kind.Transfer as { receiver_id?: string; amount?: string } | undefined;
    if (transfer) {
      const differences = [
        intent.receiverId !== transfer.receiver_id ? `recipient: Owner signed ${intent.receiverId}; on-chain ${transfer.receiver_id ?? '?'}` : '',
        intent.amount !== transfer.amount ? `amount: Owner signed ${intent.amount} yoctoNEAR; on-chain ${transfer.amount ?? '?'} yoctoNEAR` : '',
      ].filter(Boolean);
      return { status: 'mismatch', reason: differences.join('; ') || 'Owner-signed transfer fields differ from the on-chain action' };
    }
  }
  return { status: 'mismatch', reason: 'Owner-signed transfer differs from the current on-chain action' };
}

export async function configure(input: SettingsInput) {
  let nextRpc = rpc;
  if (input.nearRpcUrl) {
    const url = validateEndpoint(input.nearRpcUrl);
    nextRpc = new NearRpc(url);
    if (await nextRpc.network() !== 'testnet') throw new Error('RPC endpoint is not NEAR testnet');
  }
  let nextAi = aiConfig;
  if (input.clearAi) nextAi = null;
  else if (input.aiEndpoint || input.aiModel || input.aiApiKey) {
    const endpoint = validateEndpoint(input.aiEndpoint || aiConfig?.endpoint || '');
    chatCompletionEndpoint(endpoint);
    const model = (input.aiModel || aiConfig?.model || '').trim();
    if (!model || model.length > 100 || (input.aiApiKey && input.aiApiKey.length > 500)) throw new Error('Invalid AI model or API key');
    const apiKey = input.aiApiKey || (aiConfig && chatCompletionEndpoint(endpoint) === chatCompletionEndpoint(aiConfig.endpoint) ? aiConfig.apiKey : '') || '';
    nextAi = { endpoint, model, apiKey };
  }
  rpc = nextRpc;
  if (!nextAi || !aiConfig || nextAi.endpoint !== aiConfig.endpoint || nextAi.model !== aiConfig.model || nextAi.apiKey !== aiConfig.apiKey) aiReady = false;
  aiConfig = nextAi;
  return { nearRpcUrl: rpc.url, ai: aiConfig ? { configured: true, ready: aiReady, endpoint: aiConfig.endpoint, model: aiConfig.model } : { configured: false, ready: false, endpoint: '', model: '' } };
}

export async function testAiConnection() {
  if (!aiConfig) throw new Error('Configure AI Base URL, model and API key first');
  const testedConfig = aiConfig;
  aiReady = false;
  const testDaoId = 'connection-test.sputnik-v2.testnet';
  const proposal: Proposal = { id: 0, proposer: 'connection-test.testnet', description: 'Synthetic connection test; no transaction will be signed', kind: { Transfer: { token_id: '', receiver_id: 'unlisted.testnet', amount: nearToYocto('0.01'), msg: null } }, status: 'InProgress', votes: {}, submission_time: '0' };
  const decision = await decideProposal(testedConfig, { daoId: testDaoId, proposal, policy: { ...DEFAULT_POLICY, requireIntentMatch: false }, intent: null, intentComparison: { status: 'not_supplied', reason: 'Synthetic connection test' }, ownerConfirmation: null, spentTodayYocto: '0', evidence: { accountId: 'unlisted.testnet', accountExists: null, codeHash: null, allowlisted: false }, history: { proposedAccountId: 'unlisted.testnet', dao: { unavailable: 'Synthetic connection test' }, proposedAccountActivity: { unavailable: 'Synthetic connection test' } }, impact: { type: 'unavailable', reason: 'Synthetic connection test; no chain execution' } }, true);
  if (aiConfig !== testedConfig) throw new Error('AI settings changed during connection test; test the current settings again');
  aiReady = true;
  return { ok: true, model: aiConfig.model, status: decision.status, reason: decision.reason };
}

export async function previewImpact(id: number) {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid proposal ID');
  const proposal = await rpc.getProposal(daoId, id);
  const transfer = typeof proposal.kind === 'object' ? proposal.kind.Transfer as { token_id?: string; receiver_id?: string; amount?: string } | undefined : undefined;
  if (!transfer || transfer.token_id !== '' || !transfer.receiver_id || !isTestnetAccount(transfer.receiver_id) || !transfer.amount || !/^\d+$/.test(transfer.amount)) {
    return { type: 'unavailable', reason: 'No reliable balance projection for this proposal kind; state-changing contract calls require a sandbox replay.' };
  }
  if (proposal.status !== 'InProgress') return { type: 'unavailable', reason: 'Projection is only available for in-progress proposals.' };
  const [treasuryBalance, available, recipientBalance] = await Promise.all([
    rpc.balance(daoId), rpc.getAvailableAmount(daoId), rpc.balance(transfer.receiver_id).catch(() => null),
  ]);
  const amount = BigInt(transfer.amount);
  const enough = BigInt(available) >= amount;
  const sameAccount = transfer.receiver_id === daoId;
  const accounts: Array<{ accountId: string; beforeNear: string | null; afterNear: string | null; deltaNear: string }> = [{ accountId: daoId, beforeNear: yoctoToNear(treasuryBalance), afterNear: enough ? yoctoToNear((BigInt(treasuryBalance) - (sameAccount ? 0n : amount)).toString()) : null, deltaNear: sameAccount ? '0' : `-${yoctoToNear(transfer.amount)}` }];
  if (!sameAccount) accounts.push({ accountId: transfer.receiver_id, beforeNear: recipientBalance === null ? null : yoctoToNear(recipientBalance), afterNear: recipientBalance !== null && enough ? yoctoToNear((BigInt(recipientBalance) + amount).toString()) : null, deltaNear: `+${yoctoToNear(transfer.amount)}` });
  return {
    type: 'balance-projection', proposalId: id, amountNear: yoctoToNear(transfer.amount), executableFromAvailableBalance: enough,
    accounts,
    note: 'Conditional projection from current finalized balances, not an executed sandbox transaction. Gas, storage, proposal bonds and concurrent state changes are excluded.',
  };
}

export async function review(id: number, ignoreConfirmation = false, freshAi = false) {
  if (!isSputnikDaoId(daoId) || !isTestnetAccount(ownerId) || !isTestnetAccount(guardianId)) throw new Error('Set GUARDIAN_DAO_ID to a Sputnik V2 testnet DAO and Owner/Guardian to testnet accounts');
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid proposal ID');
  const reviewRpc = rpc;
  const reviewAi = aiConfig;
  const [onchainPolicy, proposal, localPolicy, spent, savedIntents, savedConfirmations] = await Promise.all([rpc.getPolicy(daoId), rpc.getProposal(daoId, id), policy(), spentToday(), intents(), confirmations()]);
  const saved = savedIntents[String(id)];
  let verifiedIntent: ProposalIntent | undefined;
  let intentError: string | undefined;
  let intentComparison: IntentComparison = { status: 'not_supplied', reason: 'No Owner-signed intent was supplied' };
  if (saved) {
    if (!saved.envelope || !saved.expiresAt) intentError = 'Stored signed intent is incomplete';
    else if (saved.expiresAt <= Date.now()) intentComparison = { status: 'not_supplied', reason: 'Previous Owner-signed intent expired; a new intent may be signed' };
    else {
      try {
        await verifyOwnerSignature(saved.envelope);
        const signed = JSON.parse(saved.envelope.message) as ProposalIntent & { type?: string; version?: number; expiresAt?: number };
        const commonMatches = signed.version === 1 && signed.daoId === daoId && signed.proposalId === id && signed.proposer === proposal.proposer && signed.expiresAt === saved.expiresAt;
        const dataMatches = saved.intent && ('kind' in saved.intent
          ? signed.type === 'near-guardian-call' && 'kind' in signed && sameProposalKind(saved.intent.kind, signed.kind)
          : 'text' in saved.intent
            ? signed.type === 'near-guardian-narrative' && 'text' in signed && signed.action === 'call' && saved.intent.text === signed.text.trim()
          : signed.type === 'near-guardian-transfer' && 'receiverId' in signed && saved.intent.receiverId === signed.receiverId && saved.intent.tokenId === signed.tokenId && saved.intent.amount === signed.amount);
        if (!commonMatches || !dataMatches) throw new Error('Stored intent differs from the Owner-signed message');
        verifiedIntent = saved.intent;
        intentComparison = compareSignedIntent(saved.intent, proposal);
      }
      catch (error) { intentError = `Signed intent verification failed: ${String(error)}`; }
    }
  }
  let ownerConfirmation: { reason: string } | null = null;
  let confirmationError: string | undefined;
  const confirmation = ignoreConfirmation ? undefined : savedConfirmations[String(id)];
  if (confirmation) {
    try {
      const parsed = JSON.parse(confirmation.envelope.message) as Partial<ConfirmationPayload>;
      if (parsed.type !== 'near-guardian-confirmation' || parsed.version !== 1 || parsed.daoId !== daoId || parsed.proposalId !== id || !parsed.expiresAt || parsed.expiresAt <= Date.now() || parsed.policyHash !== policyHash(localPolicy) || parsed.proposalKind === undefined || !sameProposalKind(parsed.proposalKind, proposal.kind) || typeof parsed.reason !== 'string' || !parsed.reason.trim()) throw new Error('Stored confirmation differs from proposal or policy');
      await verifyOwnerSignature(confirmation.envelope);
      ownerConfirmation = { reason: parsed.reason };
    } catch (error) { confirmationError = `Owner confirmation verification failed: ${String(error)}`; }
  }
  const council = verifyTwoOfTwo(onchainPolicy, ownerId, guardianId);
  const kind = typeof proposal.kind === 'string' ? proposal.kind : Object.keys(proposal.kind)[0] || 'Unknown';
  const facts = [`kind=${kind}`, `proposer=${proposal.proposer}`];
  let decision: Decision = { verdict: 'REVIEW', reasons: ['Waiting for AI co-signer decision'], facts };
  if (!council.ok) decision = { verdict: 'BLOCK', reasons: ['On-chain treasury is not the expected 2-of-2 council', ...council.reasons], facts };
  else if (proposal.status !== 'InProgress') decision = { verdict: 'BLOCK', reasons: ['Proposal is not in progress'], facts };
  else if (proposal.votes?.[guardianId]) decision = { verdict: 'BLOCK', reasons: ['Guardian already voted'], facts };
  else if (intentError) decision = { verdict: 'BLOCK', reasons: [intentError], facts };
  else if (!reviewAi) decision = { verdict: 'REVIEW', reasons: ['AI provider is not configured; Guardian will not sign'], facts };
  let aiDecision: AiDecision | null = null;
  let aiError: string | null = null;
  let inputFingerprint: string | null = null;
  let history: HistoryEvidence | null = null;
  if (reviewAi && decision.reasons[0] === 'Waiting for AI co-signer decision') {
    let requestStage: 'evidence' | 'model' = 'evidence';
    try {
      const [collectedHistory, address, impact] = await Promise.all([collectHistory(rpc, daoId, proposal, process.env.FASTNEAR_API_KEY || ''), addressEvidence(proposal, localPolicy), previewImpact(id)]);
      history = collectedHistory;
      const input = { daoId, proposal, policy: localPolicy, intent: verifiedIntent ?? null, intentComparison, ownerConfirmation, spentTodayYocto: spent, evidence: address, history, impact };
      inputFingerprint = createHash('sha256').update(decisionCacheKey(input)).digest('hex');
      requestStage = 'model';
      aiDecision = await decideProposal(reviewAi, input, freshAi);
      if (rpc !== reviewRpc || aiConfig !== reviewAi) throw new Error('Guardian settings changed during review; retry with current settings');
      aiReady = true;
    }
    catch (error) { aiDecision = null; inputFingerprint = null; aiError = `${requestStage === 'model' ? 'AI provider request failed' : 'Review evidence failed'}: ${String(error)}`; }
    decision = aiDecision
      ? { verdict: aiDecision.status === 'Approved' ? 'APPROVE' : aiDecision.status === 'Rejected' ? 'BLOCK' : 'REVIEW', reasons: [aiDecision.reason], facts }
      : { verdict: 'REVIEW', reasons: [aiError || 'Review is unavailable'], facts };
  }
  const reviewedAt = new Date().toISOString();
  const previous = reviewLog.get(id);
  if (!proposal.votes?.[guardianId] || !previous) {
    reviewLog.set(id, {
      proposalId: id,
      status: aiDecision?.status || (decision.verdict === 'BLOCK' ? 'Blocked' : 'Unavailable'),
      reason: decision.reasons.join('; '), reviewedAt, policyHash: policyHash(localPolicy),
      intentVerified: Boolean(verifiedIntent), intentMatches: verifiedIntent && intentComparison.status !== 'semantic_review' ? intentComparison.status === 'match' : null, history, model: aiDecision?.model,
      guardianVoteTx: previous?.guardianVoteTx ?? null,
    });
  }
  return { proposal, decision, intent: verifiedIntent ?? null, intentComparison, history, ownerConfirmation, confirmationError, policyHash: policyHash(localPolicy), inputFingerprint, spentTodayYocto: spent, spentTodayNear: yoctoToNear(spent), aiDecision, aiError, reviewedAt, guardianVoteTx: reviewLog.get(id)?.guardianVoteTx ?? null };
}

async function approveWithFirst(id: number, initialReview?: Awaited<ReturnType<typeof review>>) {
  if ((uncertainVotes.get(id) ?? 0) > Date.now()) throw new Error('Previous Guardian vote outcome is uncertain; refresh the proposal before retrying');
  uncertainVotes.delete(id);
  const signer = await signerReadiness();
  if (!signer.ready) throw new Error(signer.reason);
  if (!aiReady) await testAiConnection();
  const approvalRpc = rpc;
  const approvalAi = aiConfig;
  const first = initialReview ?? await review(id, false, true);
  if (first.decision.verdict !== 'APPROVE') throw new Error(first.decision.reasons.join('; '));
  const second = await review(id, false, true);
  if (second.decision.verdict !== 'APPROVE') throw new Error(second.decision.reasons.join('; '));
  if (rpc !== approvalRpc || aiConfig !== approvalAi || !aiReady) throw new Error('Guardian settings changed during approval; retry with current settings');
  if (!first.inputFingerprint || first.inputFingerprint !== second.inputFingerprint || first.aiDecision?.model !== second.aiDecision?.model) throw new Error('Review evidence or AI model changed between approvals; Guardian will retry with current evidence');
  const privateKey = process.env.GUARDIAN_PRIVATE_KEY;
  if (!privateKey) throw new Error('GUARDIAN_PRIVATE_KEY is required for signing');
  const account = new Account(guardianId, rpc.url, privateKey as `ed25519:${string}`);
  let outcome: Awaited<ReturnType<Account['signAndSendTransaction']>>;
  try {
    outcome = await withTimeout(account.signAndSendTransaction({
      receiverId: daoId,
      actions: [actions.functionCall('act_proposal', { id, action: 'VoteApprove', proposal: second.proposal.kind, memo: 'NEAR Guardian AI decision' }, 100_000_000_000_000n, 0n)],
    }), 45_000, 'Guardian vote submission');
  } catch (error) {
    if (String(error).includes('Guardian vote submission timed out')) uncertainVotes.set(id, Date.now() + 2 * 60_000);
    throw error;
  }
  uncertainVotes.delete(id);
  const logged = reviewLog.get(id);
  if (logged) reviewLog.set(id, { ...logged, guardianVoteTx: outcome.transaction.hash });
  stdout.write(`${JSON.stringify({ hash: outcome.transaction.hash, decision: second.decision })}\n`);
}

export async function approve(id: number) { return approveWithFirst(id); }

export async function reviewProposalAndVote(id: number) {
  const result = await review(id, false, true);
  if (result.decision.verdict === 'APPROVE') await approveWithFirst(id, result);
  return { ...result, guardianVoteTx: reviewLog.get(id)?.guardianVoteTx ?? null };
}

function serve() {
  const port = Number(process.env.PORT ?? 8787);
  const configuredOrigin = new URL(process.env.GUARDIAN_WEB_ORIGIN || 'http://127.0.0.1:5173');
  if (!['http:', 'https:'].includes(configuredOrigin.protocol) || configuredOrigin.username || configuredOrigin.password) throw new Error('GUARDIAN_WEB_ORIGIN must be an HTTP(S) origin');
  const webOrigin = configuredOrigin.origin;
  const activeReviews = new Set<number>();
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', webOrigin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.headers.origin && request.headers.origin !== webOrigin) { response.writeHead(403); response.end(JSON.stringify({ error: 'Unexpected web origin' })); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ ok: true, daoId, ownerId, guardianId, signerConfigured: Boolean(process.env.GUARDIAN_PRIVATE_KEY) }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/signer-status?')) {
      try {
        const challenge = new URL(request.url, 'http://127.0.0.1').searchParams.get('challenge') || '';
        response.end(JSON.stringify(await signerStatus(challenge)));
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
      return;
    }
    if (request.method === 'POST' && request.url === '/test-ai') {
      try { response.end(JSON.stringify(await testAiConnection())); }
      catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      try {
        if (!daoId || !ownerId) throw new Error('Guardian has not been bound to a multisig yet');
        const [localPolicy, chainPolicy, signer] = await Promise.all([policy(), rpc.getPolicy(daoId), signerReadiness()]);
        response.end(JSON.stringify({ daoId, ownerId, guardianId, policy: localPolicy, council: verifyTwoOfTwo(chainPolicy, ownerId, guardianId), signer, ai: aiConfig ? { configured: true, ready: aiReady, model: aiConfig.model } : { configured: false, ready: false, model: '' }, reviews: [...reviewLog.values()].slice(-50) }));
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
      return;
    }
    const impactMatch = request.url?.match(/^\/impact\/(\d+)$/);
    if (request.method === 'GET' && impactMatch) {
      try { response.end(JSON.stringify(await previewImpact(Number(impactMatch[1])))); }
      catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
      return;
    }
    if (request.method === 'POST' && (request.url === '/bind' || request.url === '/intent' || request.url === '/policy' || request.url === '/confirmation')) {
      try {
        let body = '';
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 16_384) throw new Error('Intent body too large'); }
        const input = JSON.parse(body) as SignedIntentEnvelope;
        response.end(JSON.stringify(request.url === '/bind' ? await bindGuardian(input) : request.url === '/intent' ? await saveIntent(input) : request.url === '/policy' ? await savePolicy(input) : await saveConfirmation(input)));
      } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
      return;
    }
    const match = request.url?.match(/^\/review\/(\d+)$/);
    if (request.method !== 'POST' || !match) { response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' })); return; }
    const id = Number(match[1]);
    if (activeReviews.has(id)) { response.writeHead(409); response.end(JSON.stringify({ error: 'Guardian is already reviewing this proposal' })); return; }
    activeReviews.add(id);
    try {
      response.end(JSON.stringify(await reviewProposalAndVote(id)));
    }
    catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
    finally { activeReviews.delete(id); }
  });
  server.listen(port, '127.0.0.1', () => stdout.write(`Guardian API at http://127.0.0.1:${port}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, idArg] = process.argv.slice(2);
  if (command === 'serve') serve();
  else if (command === 'test-ai') testAiConnection().then(result => stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1; });
  else if (command === 'review' && idArg) review(Number(idArg)).then(result => stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1; });
  else if (command === 'prompt' && idArg) Promise.all([review(Number(idArg)), readFile(new URL('../../../packages/core/prompts/risk-assessment.md', import.meta.url), 'utf8'), policy()]).then(async ([result, system, localPolicy]) => {
    stdout.write(`${JSON.stringify({ system, input: { daoId, proposal: result.proposal, policy: localPolicy, intent: result.intent, intentComparison: result.intentComparison, ownerConfirmation: result.ownerConfirmation, spentTodayYocto: result.spentTodayYocto, evidence: await addressEvidence(result.proposal, localPolicy), history: result.history ?? await collectHistory(rpc, daoId, result.proposal, process.env.FASTNEAR_API_KEY || ''), impact: await previewImpact(result.proposal.id) }, currentDecision: result.aiDecision }, null, 2)}\n`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
  else if (command === 'approve' && idArg) approve(Number(idArg)).catch(error => { console.error(error); process.exitCode = 1; });
  else { stdout.write('Usage: npm run guardian -- serve | test-ai | review <id> | prompt <id> | approve <id>\n'); process.exitCode = 1; }
}
