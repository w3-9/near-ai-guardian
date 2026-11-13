# AI Guardian

AI Guardian is a self-hosted co-signer for a 2-of-2 NEAR Testnet multisig. A proposal can describe one action while its on-chain fields send funds elsewhere, call a different contract, or change who controls the multisig. Guardian reads those fields, compares them with the Owner's signed intent and review policy, and votes only when the configured AI returns **Approved**. The Owner holds the other vote.

Today, the web app and Guardian run together on the user's machine. The Owner key stays in the wallet; a separate Guardian key stays in a local, ignored file. A future hosted version could run an isolated Guardian for each multisig, but this repository only implements the self-hosted flow.

## How to start

You need Node.js 22.22.2 or newer, npm, a Meteor or Nightly wallet on NEAR Testnet, and Testnet NEAR for setup and proposals.

```bash
npm install
cp .env.example .env
chmod 600 .env
```

Fill the private `.env` file:

| Setting | Value |
| --- | --- |
| `GUARDIAN_AI_ENDPOINT` | An OpenAI-compatible base URL or full `/chat/completions` URL. |
| `GUARDIAN_AI_MODEL` | The model name accepted by that provider. |
| `GUARDIAN_AI_API_KEY` | The provider's API key, if it requires one. |

The read-only demo does not need `.env`.

Start the live app (web + Guardian):

```bash
npm run dev
```

Or start the read-only demo (no wallet or AI key):

```bash
npm run demo:readonly
```

Open **http://127.0.0.1:5173/**.

### Addresses in the recorded demo

| Role | Testnet address |
| --- | --- |
| Multisig | [`ai-guardian.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/ai-guardian.sputnik-v2.testnet) |
| Owner wallet | [`nearaiguardian.testnet`](https://testnet.nearblocks.io/address/nearaiguardian.testnet) |

These are the accounts used in the screenshots. A new run uses the connected Owner wallet and can create a new multisig. The recipient accounts in the examples are separate from the Owner and multisig.

## Workflow

The screenshots follow a recorded Testnet session. Click any image to open it at full size. **Rejected** is an AI decision: Guardian withholds its vote, while the on-chain proposal may remain pending.

### Step 1 — Set up the multisig

Connect a Testnet wallet as the Owner. Fund the generated Guardian account with **0.5 Testnet NEAR**, then create a 2-of-2 Sputnik DAO V2 multisig with a separate **5 Testnet NEAR** deposit. The Owner signs the creation and Guardian binding requests.

After creation, connect the multisig to read its Council and funds. Set the review policy to **High**, **Moderate**, or **Confirm each**, then sign and save it. Keep `.guardian-identity.local` for future sessions; it contains this multisig’s Guardian key.

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step1-01-start-web-and-guardian.png"><img src="./screenshots/step1-01-start-web-and-guardian.png" alt="1-01 · Start web and Guardian" width="300"></a><br><sub>1-01 · Start web and Guardian</sub></td>
<td width="50%" align="center"><a href="./screenshots/step1-02-choose-testnet-wallet.png"><img src="./screenshots/step1-02-choose-testnet-wallet.png" alt="1-02 · Choose a Testnet wallet" width="300"></a><br><sub>1-02 · Choose a Testnet wallet</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step1-03-fund-guardian-and-create-multisig.png"><img src="./screenshots/step1-03-fund-guardian-and-create-multisig.png" alt="1-03 · Fund Guardian and prepare the multisig" width="300"></a><br><sub>1-03 · Fund Guardian and prepare the multisig</sub></td>
<td width="50%" align="center"><a href="./screenshots/step1-04-approve-wallet-connection.png"><img src="./screenshots/step1-04-approve-wallet-connection.png" alt="1-04 · Approve the wallet connection" width="300"></a><br><sub>1-04 · Approve the wallet connection</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step1-05-sign-multisig-creation.png"><img src="./screenshots/step1-05-sign-multisig-creation.png" alt="1-05 · Sign the multisig creation transaction" width="300"></a><br><sub>1-05 · Sign the multisig creation transaction</sub></td>
<td width="50%" align="center"><a href="./screenshots/step1-06-connect-created-multisig.png"><img src="./screenshots/step1-06-connect-created-multisig.png" alt="1-06 · Connect and verify the created multisig" width="300"></a><br><sub>1-06 · Connect and verify the created multisig</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step1-07-view-multisig-overview-and-funds.png"><img src="./screenshots/step1-07-view-multisig-overview-and-funds.png" alt="1-07 · View the multisig and on-chain funds" width="300"></a><br><sub>1-07 · View the multisig and on-chain funds</sub></td>
<td width="50%" align="center"><a href="./screenshots/step1-08-choose-review-policy-mode.png"><img src="./screenshots/step1-08-choose-review-policy-mode.png" alt="1-08 · Choose a review policy mode (captured later)" width="300"></a><br><sub>1-08 · Choose a review policy mode (captured later)</sub></td>
</tr>
</table>

### Step 2 — Review a NEAR transfer

Create a **0.1 NEAR** transfer proposal and open it from **Proposals**. The balance panel estimates the change from current on-chain balances; it does not execute or simulate the transfer.

The Owner separately signs the intended recipient and amount. In the attack case, the on-chain recipient differs, so the AI returns **Rejected** and Guardian does not vote. In a separate matching case, AI returns **Approved**, Guardian votes, and the Owner’s second vote executes the transfer. Guardian also supplies recent DAO payouts and recipient activity to the model when available.

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step2-01-draft-near-transfer.png"><img src="./screenshots/step2-01-draft-near-transfer.png" alt="2-01 · Draft a transfer" width="300"></a><br><sub>2-01 · Draft a transfer</sub></td>
<td width="50%" align="center"><a href="./screenshots/step2-02-view-pending-transfer-proposal.png"><img src="./screenshots/step2-02-view-pending-transfer-proposal.png" alt="2-02 · View the submitted, pending proposal" width="300"></a><br><sub>2-02 · View the submitted, pending proposal</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step2-03-view-estimated-transfer-balance-impact.png"><img src="./screenshots/step2-03-view-estimated-transfer-balance-impact.png" alt="2-03 · Estimate balance changes" width="300"></a><br><sub>2-03 · Estimate balance changes</sub></td>
<td width="50%" align="center"><a href="./screenshots/step2-04-open-signed-transfer-intent-form.png"><img src="./screenshots/step2-04-open-signed-transfer-intent-form.png" alt="2-04 · Open the independent intent form" width="300"></a><br><sub>2-04 · Open the independent intent form</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step2-05-sign-mismatched-transfer-intent.png"><img src="./screenshots/step2-05-sign-mismatched-transfer-intent.png" alt="2-05 · Sign an intent that differs from the proposal" width="300"></a><br><sub>2-05 · Sign an intent that differs from the proposal</sub></td>
<td width="50%" align="center"><a href="./screenshots/step2-06-reject-transfer-intent-mismatch.png"><img src="./screenshots/step2-06-reject-transfer-intent-mismatch.png" alt="2-06 · AI rejects the mismatch" width="300"></a><br><sub>2-06 · AI rejects the mismatch</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step2-07-inspect-rejected-transfer-evidence.png"><img src="./screenshots/step2-07-inspect-rejected-transfer-evidence.png" alt="2-07 · Inspect the reason and absent Guardian vote" width="300"></a><br><sub>2-07 · Inspect the reason and absent Guardian vote</sub></td>
<td width="50%" align="center"><a href="./screenshots/step2-08-approve-matching-transfer.png"><img src="./screenshots/step2-08-approve-matching-transfer.png" alt="2-08 · AI approves a separate matching transfer" width="300"></a><br><sub>2-08 · AI approves a separate matching transfer</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step2-09-confirm-executing-second-vote.png"><img src="./screenshots/step2-09-confirm-executing-second-vote.png" alt="2-09 · Confirm the Owner’s executing second vote" width="300"></a><br><sub>2-09 · Confirm the Owner’s executing second vote</sub></td>
<td width="50%" align="center"><a href="./screenshots/step2-10-view-approved-and-executed-transfer.png"><img src="./screenshots/step2-10-view-approved-and-executed-transfer.png" alt="2-10 · View the executed 2-of-2 transfer" width="300"></a><br><sub>2-10 · View the executed 2-of-2 transfer</sub></td>
</tr>
</table>

### Step 3 — Review a contract call

Create a call to `funcA` on one contract, then sign a short description of the intended action. The recorded reviews reject a different contract and method, reject a different contract alone, and approve a matching description.

These are intent and proposal checks. This PoC does not replay the contract call or predict its internal balance changes. AI approval and a Guardian vote do not prove the contract later executed successfully.

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step3-01-create-contract-call-proposal.png"><img src="./screenshots/step3-01-create-contract-call-proposal.png" alt="3-01 · Create a contract-call proposal" width="300"></a><br><sub>3-01 · Create a contract-call proposal</sub></td>
<td width="50%" align="center"><a href="./screenshots/step3-02-sign-wrong-contract-and-method-intent.png"><img src="./screenshots/step3-02-sign-wrong-contract-and-method-intent.png" alt="3-02 · Sign an intent naming another contract and method" width="300"></a><br><sub>3-02 · Sign an intent naming another contract and method</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step3-03-reject-wrong-contract-and-method.png"><img src="./screenshots/step3-03-reject-wrong-contract-and-method.png" alt="3-03 · AI rejects both differences" width="300"></a><br><sub>3-03 · AI rejects both differences</sub></td>
<td width="50%" align="center"><a href="./screenshots/step3-04-sign-wrong-contract-intent.png"><img src="./screenshots/step3-04-sign-wrong-contract-intent.png" alt="3-04 · Sign an intent naming another contract" width="300"></a><br><sub>3-04 · Sign an intent naming another contract</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step3-05-reject-wrong-contract.png"><img src="./screenshots/step3-05-reject-wrong-contract.png" alt="3-05 · AI rejects the wrong contract" width="300"></a><br><sub>3-05 · AI rejects the wrong contract</sub></td>
<td width="50%" align="center"><a href="./screenshots/step3-06-sign-matching-contract-call-intent.png"><img src="./screenshots/step3-06-sign-matching-contract-call-intent.png" alt="3-06 · Sign a matching contract-call intent" width="300"></a><br><sub>3-06 · Sign a matching contract-call intent</sub></td>
</tr>
</table>

<p align="center"><a href="./screenshots/step3-07-approve-matching-contract-call.png"><img src="./screenshots/step3-07-approve-matching-contract-call.png" alt="3-07 · AI approves and Guardian records a vote" width="300"></a><br><sub>3-07 · AI approves and Guardian records a vote</sub></p>

### Step 4 — Product website

The pages at `/` and `/demo` explain the product and show a read-only example. This is **frontend presentation**, not another on-chain action. The `vendor.testnet` versus `vend0r.testnet` comparison is illustrative; use `/app` for the live Testnet workflow.

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step4-01-show-landing-page-hero.png"><img src="./screenshots/step4-01-show-landing-page-hero.png" alt="4-01 · Landing-page introduction" width="300"></a><br><sub>4-01 · Landing-page introduction</sub></td>
<td width="50%" align="center"><a href="./screenshots/step4-02-explain-signing-attack-surface.png"><img src="./screenshots/step4-02-explain-signing-attack-surface.png" alt="4-02 · Signing attack surface" width="300"></a><br><sub>4-02 · Signing attack surface</sub></td>
</tr>
</table>

<table align="center" width="80%">
<tr>
<td width="50%" align="center"><a href="./screenshots/step4-03-show-guardian-risk-checks.png"><img src="./screenshots/step4-03-show-guardian-risk-checks.png" alt="4-03 · Guardian checks" width="300"></a><br><sub>4-03 · Guardian checks</sub></td>
<td width="50%" align="center"><a href="./screenshots/step4-04-explain-review-process.png"><img src="./screenshots/step4-04-explain-review-process.png" alt="4-04 · Review process" width="300"></a><br><sub>4-04 · Review process</sub></td>
</tr>
</table>

<p align="center"><a href="./screenshots/step4-05-show-illustrative-recipient-mismatch.png"><img src="./screenshots/step4-05-show-illustrative-recipient-mismatch.png" alt="4-05 · Illustrative recipient mismatch" width="300"></a><br><sub>4-05 · Illustrative recipient mismatch</sub></p>
