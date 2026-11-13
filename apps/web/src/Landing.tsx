import './landing.css';
import { AddressComparison } from './AddressComparison';

export function GuardianMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M13 4 5 8v12l8 7" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round"/>
    <path className="guardian-mark-secondary" d="m19 4 8 4v12l-8 7" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="m10 16 4 4 8-9" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 10h12m-4.5-4.5L15.5 10 11 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function LandingPage({ onEnterWorkspace, onEnterDemo, publicDemo = false }: { onEnterWorkspace: () => void; onEnterDemo: () => void; publicDemo?: boolean }) {
  return <div className="landing">
    <header className="landing-header">
      <div className="landing-header-inner">
        <a className="landing-wordmark" href="/" aria-label="AI Guardian home"><GuardianMark/><span>AI Guardian</span></a>
        <nav className="landing-nav" aria-label="Product navigation"><a href="#why">The problem</a><a href="#risks">What gets checked</a><a href="#how">The review</a></nav>
        <button className="landing-header-action" onClick={onEnterDemo}>Explore demo <ArrowIcon/></button>
      </div>
    </header>
    <main>
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <div className="landing-kicker">AI co-signer for NEAR multisigs</div>
          <h1>Sign the action<br/>you intended.</h1>
          <p>Proposal descriptions can be wrong. Guardian reads the action stored on-chain, compares it with your policy and any separately signed intent, then decides whether to cast its Council vote.</p>
          <div className="landing-actions"><button className="landing-primary" onClick={onEnterDemo}>Explore a review <ArrowIcon/></button><button className="landing-inline-action" onClick={onEnterWorkspace}>{publicDemo ? 'View workspace' : 'Open app'} <ArrowIcon/></button></div>
          <p className="landing-demo-note">Read-only demo · No wallet needed</p>
          <div className="landing-hero-foot">Built for Sputnik DAO V2 on NEAR Testnet</div>
        </div>
        <div className="landing-preview" aria-label="Illustrative transaction review">
          <div className="landing-preview-top"><span>GUARDIAN / PROPOSAL REVIEW</span><small>Illustrative example</small></div>
          <div className="landing-preview-body">
            <div className="preview-meta"><span>Sputnik DAO · Proposal 07</span><span className="preview-pending">Awaiting review</span></div>
            <h2>Transfer</h2>
            <div className="preview-amount">5.00 <span>NEAR</span></div>
            <p className="preview-description">Unverified note: “Vendor payment”</p>
            <div className="preview-rule"/>
            <AddressComparison expected="vendor.testnet" actual="vend0r.testnet" expectedLabel="Intended recipient" actualLabel="Proposed recipient" allowCopy={false}/>
            <div className="preview-decision"><span className="preview-decision-icon">×</span><div><b>Signature would be withheld</b><small>Signed intent and on-chain recipient differ by one character.</small></div></div>
          </div>
          <div className="landing-preview-bottom"><span>Based on on-chain action</span><span>No vote submitted</span></div>
        </div>
      </section>

      <section className="landing-story" id="why">
        <div className="landing-section-label">The problem</div>
        <div className="landing-story-head"><h2>A valid signature can<br/>approve the wrong action.</h2><aside className="landing-exposure" aria-label="Historical exposure in comparable incidents"><span>Comparable incidents involved</span><strong>~$1.47B</strong><small><a href="https://www.bybit.com/en/learn/this-week-in-bybit/bybit-security-incident-timeline" target="_blank" rel="noreferrer">Bybit</a> · <a href="https://x.com/PeckShieldAlert/status/1730045158509727968" target="_blank" rel="noreferrer">Florence Finance</a> · <a href="https://www.chainalysis.com/blog/address-poisoning-scam/" target="_blank" rel="noreferrer">WBTC poisoning</a></small><small>Historical exposure, not measured savings.</small></aside></div>
        <div className="signing-path" aria-label="Potential weak points between intent and signature">
          <div className="signing-path-caption"><span>From intent to approval</span><span>Each step can change what the signer sees</span></div>
          <div className="signing-path-track">
            <div className="signing-stage endpoint"><span>Start</span><h3>Your intent</h3></div>
            <div className="signing-stage weak"><span>Surface</span><h3>Website</h3><p>Altered interface</p></div>
            <div className="signing-stage weak"><span>Data</span><h3>RPC</h3><p>Misleading response</p></div>
            <div className="signing-stage weak"><span>Prompt</span><h3>Wallet extension</h3><p>Incomplete details</p></div>
            <div className="signing-stage weak"><span>Device</span><h3>Hardware wallet</h3><p>Blind signing</p></div>
            <div className="signing-stage endpoint final"><span>Result</span><h3>Signed action</h3></div>
          </div>
        </div>
      </section>

      <section className="landing-risks" id="risks">
        <div className="landing-section-label">What gets checked</div>
        <div className="landing-risks-heading"><h2>The details that change<br/>the decision.</h2><p>Each review starts with the actual proposal and adds the policy, signed intent, and available payment history.</p></div>
        <div className="landing-risk-strip">
          <article className="landing-risk-item"><span className="landing-risk-index">Recipient</span><h3>Lookalike address</h3><p>Compare the full address with trusted payees, past payouts, and any signed intent.</p><code>vendor → vend0r</code></article>
          <article className="landing-risk-item"><span className="landing-risk-index">Contract</span><h3>Hidden call</h3><p>Read the target, method, arguments, and deposit even when the description looks routine.</p><code>contract.method(args)</code></article>
          <article className="landing-risk-item"><span className="landing-risk-index">Council</span><h3>New signer</h3><p>See who would gain voting power against the signed policy.</p><code>+ council member</code></article>
          <article className="landing-risk-item"><span className="landing-risk-index">Amount</span><h3>Oversized payout</h3><p>Put the requested transfer beside recent spend and the chosen limits.</p><code>amount + 24h spend &gt; cap</code></article>
        </div>
        <p className="landing-policy-note">The model makes the risk decision. Guardian verifies signatures, Council membership, and the exact proposal before voting.</p>
      </section>

      <section className="landing-how" id="how">
        <div className="landing-section-label">The review</div>
        <div className="landing-how-layout"><div className="landing-how-heading"><h2>Read. Compare.<br/>Then decide.</h2><p>A clear outcome for every proposal: Approved, Rejected, or Needs user confirmation.</p></div>
        <div className="landing-steps"><div><span>01</span><h3>Read the proposal</h3><p>Fetch the recipient, amount, contract call, or Council change from Sputnik DAO.</p></div><div><span>02</span><h3>Compare independent evidence</h3><p>Bring in the signed policy, any Owner intent, and available transaction history.</p></div><div><span>03</span><h3>Decide before voting</h3><p>Guardian casts a Council vote only when the model returns Approved.</p></div></div></div>
      </section>

      <section className="landing-cta"><div><h2>See the review before you connect.</h2><p>{publicDemo ? 'Explore the read-only Testnet demo. The self-hosted Guardian and signing flow are shown in the demo video and repository.' : 'Explore the read-only demo, then connect a compatible Sputnik DAO V2 multisig on Testnet.'}</p></div><button className="landing-primary" onClick={onEnterDemo}>Explore demo <ArrowIcon/></button></section>
    </main>
    <footer className="landing-footer"><span><GuardianMark/> AI Guardian</span><span>NEAR Testnet · Proof of concept</span></footer>
  </div>;
}
