import { readFile } from 'node:fs/promises';
import type { GuardianPolicy, Proposal, ProposalIntent } from '@guardian/core';
import type { HistoryEvidence } from './history';

export type AiConfig = { endpoint: string; model: string; apiKey: string };
export type AiStatus = 'Approved' | 'Rejected' | 'Needs user confirmation';
export type AiDecision = { daoId: string; proposalId: number; status: AiStatus; reason: string; model: string };
export type AiEvidence = { accountId: string | null; accountExists: boolean | null; codeHash: string | null; allowlisted: boolean };
export type IntentComparison = { status: 'match' | 'mismatch' | 'semantic_review' | 'not_supplied'; reason: string };
export type AiInput = { daoId: string; proposal: Proposal; policy: GuardianPolicy; intent: ProposalIntent | null; intentComparison: IntentComparison; ownerConfirmation: { reason: string } | null; spentTodayYocto: string; evidence: AiEvidence; history: HistoryEvidence; impact: unknown };
const reports = new WeakMap<AiConfig, Map<string, Promise<AiDecision>>>();

export function decisionCacheKey(input: AiInput): string {
  const history = input.history;
  return JSON.stringify({
    ...input,
    history: {
      ...history,
      dao: 'unavailable' in history.dao ? history.dao : { ...history.dao, queriedAt: undefined },
      proposedAccountActivity: 'unavailable' in history.proposedAccountActivity
        ? history.proposedAccountActivity
        : { ...history.proposedAccountActivity, queriedAt: undefined },
    },
  });
}

export function validateEndpoint(input: string): string {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Endpoint must use HTTPS, except localhost');
  if (url.username || url.password || url.hash || input.length > 500) throw new Error('Invalid endpoint URL');
  return url.toString();
}

export function chatCompletionEndpoint(input: string): string {
  const url = new URL(validateEndpoint(input));
  if (!url.pathname.endsWith('/chat/completions')) {
    if (url.search) throw new Error('Base URL with query parameters needs a full Chat Completions endpoint');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  }
  return url.toString();
}

export async function decideProposal(config: AiConfig, input: AiInput, fresh = false): Promise<AiDecision> {
  if (fresh) return requestDecision(config, input);
  let byInput = reports.get(config);
  if (!byInput) { byInput = new Map(); reports.set(config, byInput); }
  const key = decisionCacheKey(input);
  const cached = byInput.get(key);
  if (cached) return cached;
  const pending = requestDecision(config, input);
  byInput.set(key, pending);
  if (byInput.size > 100) byInput.delete(byInput.keys().next().value!);
  try { return await pending; }
  catch (error) { byInput.delete(key); throw error; }
}

async function requestDecision(config: AiConfig, input: AiInput): Promise<AiDecision> {
  const endpoint = chatCompletionEndpoint(config.endpoint);
  if (!config.model.trim() || config.model.length > 100) throw new Error('AI model is required');
  const system = await readFile(new URL('../../../packages/core/prompts/risk-assessment.md', import.meta.url), 'utf8');
  const timeout = AbortSignal.timeout(60_000);
  let result: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
      signal: timeout,
    });
    if (!response.ok) throw new Error(`AI API returned HTTP ${response.status}`);
    result = await response.json() as typeof result;
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError' || timeout.aborted && (timeout.reason as Error)?.name === 'TimeoutError') throw new Error('AI provider did not complete its response within 60 seconds');
    throw error;
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length > 10_000) throw new Error('AI API returned no usable message');
  const parsed = JSON.parse(content) as { daoId?: unknown; proposalId?: unknown; status?: unknown; reason?: unknown };
  if (parsed.daoId !== input.daoId || parsed.proposalId !== input.proposal.id || !['Approved', 'Rejected', 'Needs user confirmation'].includes(String(parsed.status)) || typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 1000) throw new Error('AI decision is malformed or refers to another proposal');
  return { daoId: input.daoId, proposalId: input.proposal.id, status: parsed.status as AiStatus, reason: parsed.reason.trim(), model: config.model };
}
