// Profile avatars — a chosen sprite path under /avatars/ (e.g. 'default/151.png'), or a deterministic
// default sprite derived from a stable seed (the userId) so everyone has a consistent sprite before they
// pick one. The sprite set is the gen 1–5 Black/White pixel sprites bundled in apps/web/public/avatars/.
export const AVATAR_DEX_MAX = 649; // #1–649 (gen 1–5), present in both /avatars/default and /avatars/shiny

/** Resolve a renderable avatar URL. `avatar` is the stored choice (or null); `seed` (the userId) drives a
 *  stable fallback so a user always has a sprite. */
export function avatarSrc(avatar, seed = '') {
  if (avatar) return `/avatars/${avatar}`;
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return `/avatars/default/${(h % AVATAR_DEX_MAX) + 1}.png`;
}

/** <img onError> that swaps a missing sprite for the deterministic default (once, so it can't loop). */
export function avatarFallback(seed) {
  return (e) => { e.currentTarget.onerror = null; e.currentTarget.src = avatarSrc(null, seed); };
}
