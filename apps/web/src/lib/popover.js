import { useState, useEffect, useRef, useCallback } from 'react';

/** A popover under a trigger, position: fixed from the trigger's on-screen rect and kept inside the window — so a
 *  parent column's overflow can't clip it. It follows the trigger on scroll/resize (phones resize as the address bar
 *  hides), scrolls inside when long, and closes on an outside tap or Escape (focus back to the trigger). */
export function useFixedPopover(maxWidth = 360) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const place = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(maxWidth, window.innerWidth - 16);
    const top = r.bottom + 6;
    setBox({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width, maxHeight: Math.max(160, window.innerHeight - top - 8) });
  }, [maxWidth]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  const toggle = () => { place(); setOpen((v) => !v); };
  return { open, setOpen, box, wrapRef, triggerRef, toggle };
}
