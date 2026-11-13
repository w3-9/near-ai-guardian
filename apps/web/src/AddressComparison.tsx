import { useState } from 'react';
import './address-comparison.css';

function ComparedAddress({ value, other }: { value: string; other: string }) {
  return <code className="compared-address" aria-label={value}>
    {Array.from(value).map((character, index) =>
      character === other[index]
        ? <span key={index}>{character}</span>
        : <mark key={index} aria-label={`different character ${character}`}>{character}</mark>
    )}
  </code>;
}

export function AddressComparison({ expected, actual, expectedLabel = 'Intended recipient', actualLabel = 'On-chain recipient', allowCopy = true }: {
  expected: string;
  actual: string;
  expectedLabel?: string;
  actualLabel?: string;
  allowCopy?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const matches = expected === actual;

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { setCopied(null); }
  }

  return <div className={`address-comparison ${matches ? 'matches' : 'differs'}`}>
    <div className="comparison-row"><span>{expectedLabel}</span><ComparedAddress value={expected} other={actual}/>{allowCopy && <button onClick={() => void copy(expected)} aria-label={`Copy ${expectedLabel.toLowerCase()}`}>{copied === expected ? 'Copied' : 'Copy'}</button>}</div>
    <div className="comparison-row"><span>{actualLabel}</span><ComparedAddress value={actual} other={expected}/>{allowCopy && <button onClick={() => void copy(actual)} aria-label={`Copy ${actualLabel.toLowerCase()}`}>{copied === actual ? 'Copied' : 'Copy'}</button>}</div>
    <div className="comparison-outcome" role="status"><span aria-hidden="true">{matches ? '✓' : '!'}</span>{matches ? 'Recipient matches the supplied intent' : 'Intended and on-chain recipients do not match'}</div>
  </div>;
}
