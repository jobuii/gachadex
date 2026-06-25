import { useId } from 'react';

// The Gold currency icon — a small isometric gold-bar ingot (replaces the generic 🪙 coin for loyalty Gold).
// Gradient ids are made unique per instance via useId so multiple bars on a page never collide.
export function GoldBar({ size = 18, className = '' }) {
  const id = useId();
  return (
    <svg width={size} height={Math.round(size * 0.76)} viewBox="0 0 40 30" className={`gold-bar ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff3c4" /><stop offset="1" stopColor="#ffd24d" /></linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd24d" /><stop offset="1" stopColor="#cf8f06" /></linearGradient>
      </defs>
      <path d="M11 12 L29 12 L34 6 L16 6 Z" fill={`url(#${id}t)`} />
      <path d="M29 12 L34 6 L34 18 L29 25 Z" fill="#bd8408" />
      <path d="M11 12 L29 12 L31 25 L9 25 Z" fill={`url(#${id}f)`} />
      <path d="M11 12 L29 12 L29 13 L11 13 Z" fill="#fff4cf" opacity="0.7" />
    </svg>
  );
}
