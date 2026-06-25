// Docs content registry. Each section is a Markdown file imported as a raw string (Vite `?raw`) and rendered
// by pages/Docs.jsx. To add/edit docs: write the .md, then register it here — no JSX to touch.
import overview from './overview.md?raw';
import indices from './indices.md?raw';
import trading from './trading.md?raw';

const SOON = '_This section is being written — check back shortly._';

export const DOC_SECTIONS = [
  { id: 'overview', title: 'Overview', content: overview },
  { id: 'getting-started', title: 'Getting Started', content: SOON },
  { id: 'markets', title: 'Markets', content: SOON },
  { id: 'indices', title: 'The Indices', content: indices },
  { id: 'trading', title: 'Trading', content: trading },
  { id: 'fees', title: 'Fees & Funding', content: SOON },
  { id: 'oracle', title: 'Pricing & Oracle', content: SOON },
  { id: 'lp', title: 'Liquidity Pool', content: SOON },
  { id: 'risk', title: 'Risk', content: SOON },
  { id: 'referral', title: 'Referrals & Affiliates', content: SOON },
  { id: 'social', title: 'Social: Chat, DROP & Leaderboard', content: SOON },
  { id: 'custody', title: 'Custody & Security', content: SOON },
  { id: 'api', title: 'API & CLI', content: SOON },
  { id: 'faq', title: 'FAQ', content: SOON },
];
