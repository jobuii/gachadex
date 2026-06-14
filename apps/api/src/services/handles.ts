import { shortenPubkey } from '@pokex/pricing';

/** Chat display name: the user's chosen username, else a truncated pubkey (same rule as the leaderboard). */
export const handleFor = (displayName: string | null, pubkey: string): string => displayName || shortenPubkey(pubkey) || 'anon';
