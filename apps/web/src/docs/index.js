// Docs content registry. Each section is a Markdown file imported as a raw string (Vite `?raw`) and rendered
// by pages/Docs.jsx. To add/edit docs: write the .md, then register it here — no JSX to touch.
// NB: section `id`s double as in-doc anchor targets (e.g. [Risk](#risk)) — keep them stable.
import overview from './overview.md?raw';
import gettingStarted from './getting-started.md?raw';
import markets from './markets.md?raw';
import indices from './indices.md?raw';
import trading from './trading.md?raw';
import fees from './fees.md?raw';
import oracle from './oracle.md?raw';
import lp from './lp.md?raw';
import risk from './risk.md?raw';
import referral from './referral.md?raw';
import social from './social.md?raw';
import games from './games.md?raw';
import goldRewards from './gold-rewards.md?raw';
import custody from './custody.md?raw';
import api from './api.md?raw';
import faq from './faq.md?raw';

export const DOC_SECTIONS = [
  { id: 'overview', title: 'Overview', content: overview },
  { id: 'getting-started', title: 'Getting Started', content: gettingStarted },
  { id: 'markets', title: 'Markets', content: markets },
  { id: 'indices', title: 'The Indices', content: indices },
  { id: 'trading', title: 'Trading', content: trading },
  { id: 'fees', title: 'Fees & Funding', content: fees },
  { id: 'oracle', title: 'Pricing & Oracle', content: oracle },
  { id: 'lp', title: 'Liquidity Pool', content: lp },
  { id: 'risk', title: 'Risk', content: risk },
  { id: 'referral', title: 'Referrals & Affiliates', content: referral },
  { id: 'social', title: 'Social: Chat, DROP & Leaderboard', content: social },
  { id: 'games', title: 'Games', content: games },
  { id: 'gold-rewards', title: 'Gold Rewards', content: goldRewards },
  { id: 'custody', title: 'Custody & Security', content: custody },
  { id: 'api', title: 'API & CLI', content: api },
  { id: 'faq', title: 'FAQ', content: faq },
];
