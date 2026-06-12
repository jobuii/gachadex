/**
 * The market displayName format. Format + parse live side by side so they can never drift: every
 * provider mapper builds names with formatDisplayName, and the backfill parses them back here.
 */
export function formatDisplayName(name: string, number: string | null | undefined): string {
  return `${name}${number ? ' #' + number : ''}`;
}

/** "Charizard ex #223" -> { name: 'Charizard ex', number: '223' } (inverse of formatDisplayName). */
export function parseDisplayName(displayName: string): { name: string; number: string | null } {
  const m = displayName.match(/^(.*) #([^#]+)$/);
  return m ? { name: m[1], number: m[2] } : { name: displayName, number: null };
}
