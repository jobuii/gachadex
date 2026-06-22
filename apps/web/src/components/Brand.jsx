import { useId } from 'react';

/**
 * The GachaDex brand mark — a 3D hexagonal gem (cyan→pink top facet + violet sides).
 * Inline SVG so it's crisp at any size, theme-independent, and needs no image asset.
 * The gem is the FIXED logo across every skin; the wordmark text adapts per skin (see Brand).
 */
export function BrandMark({ size = 28, className = '' }) {
  const id = useId().replace(/:/g, ''); // unique gradient id per instance (valid in url())
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id={`gdx-${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22D3EE" />
          <stop offset="100%" stopColor="#F472B6" />
        </linearGradient>
      </defs>
      <path d="M100,100 L100,25 L164.9,62.5 Z" fill={`url(#gdx-${id})`} />
      <path d="M100,100 L164.9,62.5 L164.9,137.5 Z" fill="#5B21B6" />
      <path d="M100,100 L164.9,137.5 L100,175 Z" fill="#4C1D95" />
      <path d="M100,100 L100,175 L35.1,137.5 Z" fill="#3B0764" />
      <path d="M100,100 L35.1,137.5 L35.1,62.5 Z" fill="#4338CA" />
      <path d="M100,100 L35.1,62.5 L100,25 Z" fill="#6D28D9" />
    </svg>
  );
}

/** GACHA (in the skin's text colour) + DEX (the brand gradient on GachaDex, the skin's accent elsewhere). */
export function Wordmark({ className = '' }) {
  return (
    <span className={`gdx-wordmark ${className}`}>
      <span className="gdx-wm-g">GACHA</span><span className="gdx-wm-d">DEX</span>
    </span>
  );
}

/** Full lockup: gem + wordmark. Used in the navbar and the landing nav. */
export default function Brand({ size = 28, className = '' }) {
  return (
    <span className={`gdx-brand ${className}`}>
      <BrandMark size={size} />
      <Wordmark />
    </span>
  );
}
