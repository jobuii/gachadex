// Tiny sound manager for the Classic Gacha reveal (docs/classic-gacha-cc-packs-spec.md).
// Named clips live in /sounds/gacha/<file>.mp3 (drop them into apps/web/public/sounds/gacha/).
// Sound is ON by default with a persisted mute toggle; a missing/blocked file fails SILENTLY so the
// reveal always works even before the assets land. Tiered by rarity per casino win-sound research
// (3–5 levels, each more celebratory; the epic jackpot is the multi-layer centerpiece).

const BASE = '/sounds/gacha';
// logical name → file stem. Tweak here if the asset set changes.
const FILES = {
  rip: 'rip',
  beat: 'beat',
  flip: 'flip',
  winCommon: 'win-common',
  winRare: 'win-rare',
  winEpic: 'win-epic',
  coins: 'coins',
  confetti: 'confetti',
  click: 'click',
};

const MUTE_KEY = 'gdex_gacha_muted';
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* SSR / privacy mode */ }

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = Boolean(m);
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
  return muted;
}
export function toggleMuted() { return setMuted(!muted); }

/** Play a named clip with a FRESH element each call — guarantees the right clip plays (a cached/cloned element
 *  could silently replay the wrong buffer) and lets triggers overlap. Returns the element (to stop a loop) or null. */
export function playSound(name, { volume = 1, loop = false } = {}) {
  if (muted) return null;
  const file = FILES[name];
  if (!file || typeof Audio === 'undefined') return null;
  try {
    const a = new Audio(`${BASE}/${file}.mp3`);
    a.volume = Math.max(0, Math.min(1, volume));
    a.loop = loop;
    a.play().catch(() => {}); // autoplay policy / missing file → no-op
    return a;
  } catch {
    return null;
  }
}

/** Stop a looping clip returned by playSound (e.g. the coin shower when the reveal closes). */
export function stopSound(audio) {
  if (!audio) return;
  try { audio.pause(); audio.currentTime = 0; } catch { /* ignore */ }
}
