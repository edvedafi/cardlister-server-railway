/**
 * Wrap text in an OSC 8 terminal hyperlink. Terminals without OSC 8 support
 * silently drop the escape sequences and just show `text`, so callers should
 * pass the URL itself as the text — it stays visible and copyable everywhere.
 */
export function terminalLink(url: string, text: string = url): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/**
 * The SportLots public listing page for a set. SportLots stores the set id on
 * the leaf category (`metadata.sportlots`); the search URL wraps it in S…S
 * (e.g. 202896 → S202896S). Returns null when the set has no SportLots id.
 */
export function sportlotsSetUrl(sportlotsSetId: unknown): string | null {
  if (!sportlotsSetId) return null;
  return `https://sportlots.com/b/ui/search.tpl?search_val=S${sportlotsSetId}S`;
}
