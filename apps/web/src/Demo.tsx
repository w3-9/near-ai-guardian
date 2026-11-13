import { type Proposal } from '@guardian/core';
import { AddressComparison } from './AddressComparison';
import { GuardianMark } from './Landing';
import './demo.css';

// This preview is illustrative. A fresh multisig is created from the connected Owner wallet in /app.
export const DEMO_DAO = { daoId: 'example.sputnik-v2.testnet', ownerId: 'owner.testnet', guardianId: 'cosigner.testnet' };
export const DEMO_PROPOSAL_ID = 0;
export const DEMO_PROPOSAL: Proposal = {
  id: DEMO_PROPOSAL_ID,
  proposer: DEMO_DAO.ownerId,
  description: 'Vendor payment',
  kind: { Transfer: { token_id: '', receiver_id: 'vend0r.testnet', amount: '100000000000000000000000', msg: null } },
  status: 'InProgress',
  votes: {},
  submission_time: '0',
};

export function DemoPage({ onHome, onExplore, onOpenApp, publicDemo = false }: { onHome: () => void; onExplore: () => void; onOpenApp: () => void; publicDemo?: boolean }) {
  return <div className="demo-page">
    <header className="demo-header"><button onClick={onHome} className="demo-brand" aria-label="AI Guardian home"><GuardianMark/> AI Guardian</button><span>Illustrative walkthrough</span>{!publicDemo && <button className="demo-header-link" onClick={onOpenApp}>Create multisig ↗</button>}</header>
    <main className="demo-main">
      <div className="demo-eyebrow">A recipient check</div>
      <h1>One changed character.<br/>One reason to pause.</h1>
      <p className="demo-intro">A proposal description can say “vendor payment” while the recipient in the actual transaction is different. Guardian checks the action stored by the multisig against an independently supplied intent.</p>
      <section className="demo-example" aria-label="Illustrative address comparison">
        <div className="demo-example-top"><span>Illustrative example</span><b>Vendor payment</b><small>Example values, no transaction submitted</small></div>
        <div className="demo-history-signal"><span>Previous approved payouts</span><strong>3 × vendor.testnet</strong><small>Example history supplied to the AI reviewer</small></div>
        <AddressComparison expected="vendor.testnet" actual="vend0r.testnet" expectedLabel="Intended recipient" actualLabel="Proposed recipient"/>
        <div className="demo-verdict"><span>Illustrative Guardian decision</span><strong>Withhold co-signature</strong><p>A signed intent naming <code>vendor.testnet</code> differs from the proposed recipient. This is the mismatch the Guardian sends to the model.</p></div>
      </section>
      <section className="demo-chain" aria-label="Illustrative workspace preview"><div><span>Workspace preview</span><h2>See how the review appears.</h2><p>Open a read-only example of the proposal detail and approval timeline. All accounts and decisions in this preview are illustrative; create a new multisig with your own wallet for a live Testnet run.</p></div><div className="demo-chain-state"><span>Sputnik DAO V2 · Example proposal</span><strong>vend0r.testnet</strong><small>Guardian vote: withheld in this example · No transaction submitted</small></div></section>
      <div className="demo-actions"><button className="demo-primary" onClick={onExplore}>Explore the workspace preview →</button>{!publicDemo && <button className="demo-secondary" onClick={onOpenApp}>Create your multisig</button>}<small>No wallet or AI key required to browse this example.</small></div>
    </main>
  </div>;
}
