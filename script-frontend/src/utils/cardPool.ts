import path from 'path';
import { createLogger } from './logger.js';

const debug = createLogger('card-pool');

/** Get a display name for a card — prefer originalFilename, fall back to path basename. */
function cardLabel(card: UnmatchedCard): string {
  const name = card.originalFilename ?? path.basename(card.path);
  const player = card.player ?? 'unknown';
  return `${player} (${name})`;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CardSide = 'front' | 'back';

export interface UnmatchedCard {
  path: string;
  side: CardSide;
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  textDetectionCount: number;
  timestamp: number;
  ocrText?: string;    // cached raw OCR text, lowercased
  ocrWords?: string[]; // cached individual OCR words, lowercased
  originalFilename?: string; // original input filename before cropping
  originalPath?: string; // pre-crop source absolute path, if autoCrop produced a cropped copy
}

export type OcrTextResolver = (imagePath: string) => Promise<{ text: string; words: string[] } | null>;

export interface MatchResult {
  front: UnmatchedCard;
  back: UnmatchedCard;
  confidence: 'exact' | 'fuzzy' | 'side-only';
}

// ── Fuzzy matching helpers ───────────────────────────────────────────────────

const NAME_SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b\.?/gi;

function normalizePlayerName(name: string): string {
  return name.toLowerCase().replace(NAME_SUFFIXES, '').replace(/[.\-']/g, '').replace(/\s+/g, ' ').trim();
}

function getLastName(normalized: string): string {
  const parts = normalized.split(' ');
  return parts[parts.length - 1];
}

/**
 * Check if two player names match.
 * Handles exact match, last-name match, and abbreviated first names
 * (e.g., "P. Mahomes" vs "Patrick Mahomes").
 */
function playerNamesMatch(a: string, b: string): { match: boolean; exact: boolean } {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);

  // Exact match after normalization
  if (na === nb) return { match: true, exact: true };

  // Last name match
  const lastA = getLastName(na);
  const lastB = getLastName(nb);
  if (lastA !== lastB) return { match: false, exact: false };

  // Last names match — check if first names are compatible
  const partsA = na.split(' ');
  const partsB = nb.split(' ');

  // Abbreviated first name: "p" matches "patrick"
  if (partsA.length >= 1 && partsB.length >= 1) {
    const firstA = partsA[0];
    const firstB = partsB[0];
    if (firstA.length === 1 && firstB.startsWith(firstA)) return { match: true, exact: false };
    if (firstB.length === 1 && firstA.startsWith(firstB)) return { match: true, exact: false };
  }

  // Last name matched — check first name compatibility
  if (partsA.length >= 2 && partsB.length >= 2) {
    const firstA = partsA[0];
    const firstB = partsB[0];
    // Accept if one first name is a prefix of the other (min 2 chars)
    // Handles "Rob"/"Robert", "Pat"/"Patrick", etc.
    const shorter = firstA.length <= firstB.length ? firstA : firstB;
    const longer = firstA.length <= firstB.length ? firstB : firstA;
    if (shorter.length >= 2 && longer.startsWith(shorter)) {
      return { match: true, exact: false };
    }
    // Different first names — not a match
    return { match: false, exact: false };
  }

  return { match: false, exact: false };
}

/**
 * Check if two team names match.
 * Handles exact match and substring containment
 * (e.g., "Chiefs" in "Kansas City Chiefs").
 */
function teamNamesMatch(a: string, b: string): { match: boolean; exact: boolean } {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();

  if (na === nb) return { match: true, exact: true };
  if (na.includes(nb) || nb.includes(na)) return { match: true, exact: false };

  return { match: false, exact: false };
}

/**
 * Check if a player name (or last name) appears in OCR text/words.
 */
function nameFoundInOcrText(playerName: string, ocrText: string, ocrWords: string[]): boolean {
  const normalized = normalizePlayerName(playerName);
  // Full name substring check
  if (ocrText.includes(normalized)) return true;
  // Last name as standalone word
  const lastName = getLastName(normalized);
  if (lastName.length >= 3 && ocrWords.includes(lastName)) return true;
  return false;
}

// ── Card Pool ────────────────────────────────────────────────────────────────

export class CardPool {
  private cards = new Map<string, UnmatchedCard>();
  private ocrResolver: OcrTextResolver | null;

  constructor(ocrResolver?: OcrTextResolver) {
    this.ocrResolver = ocrResolver ?? null;
  }

  get size(): number {
    return this.cards.size;
  }

  entries(): IterableIterator<UnmatchedCard> {
    return this.cards.values();
  }

  remove(path: string): boolean {
    return this.cards.delete(path);
  }

  /**
   * Evict any already-pooled card that shares side + player/team identity
   * with `card`. Used so that a freshly-scanned image always replaces an
   * older one waiting in the pool — the user may be deliberately re-scanning
   * a card whose prior scan was skewed, blurry, or otherwise unwanted.
   */
  private removeSameSideDuplicate(card: UnmatchedCard): void {
    if (!card.player && !card.team) return;

    for (const existing of this.cards.values()) {
      if (existing.side !== card.side) continue;
      if (existing.path === card.path) continue;

      const bothHavePlayers = Boolean(card.player && existing.player);
      const neitherHasPlayer = !card.player && !existing.player;
      const bothHaveTeams = Boolean(card.team && existing.team);

      const isReplacement =
        (bothHavePlayers && playerNamesMatch(card.player!, existing.player!).match) ||
        (neitherHasPlayer && bothHaveTeams && teamNamesMatch(card.team!, existing.team!).match);

      if (isReplacement) {
        debug(`Replacing stale pool entry ${cardLabel(existing)} with ${cardLabel(card)}`);
        this.cards.delete(existing.path);
        return;
      }
    }
  }

  /**
   * Add a card to the pool and attempt to find a matching counterpart.
   * Returns a MatchResult if a match is found, or null if the card is held.
   */
  async addCard(card: UnmatchedCard): Promise<MatchResult | null> {
    // Evict any stale same-side scan before matching so the newer image wins.
    this.removeSameSideDuplicate(card);

    // Fast path: direct field matching (synchronous)
    const match = this.findMatch(card);
    if (match) {
      this.cards.delete(match.front.path === card.path ? match.back.path : match.front.path);
      return match;
    }

    // OCR fallback: check if any opposite-side card's name appears in this card's OCR text
    if (this.ocrResolver) {
      const ocrMatch = await this.findMatchWithOCR(card);
      if (ocrMatch) {
        this.cards.delete(ocrMatch.front.path === card.path ? ocrMatch.back.path : ocrMatch.front.path);
        return ocrMatch;
      }
    }

    // No match found — hold the card (OCR text is already cached from findMatchWithOCR)
    this.cards.set(card.path, card);
    return null;
  }

  /**
   * Find the best matching card of the opposite side in the pool.
   */
  findMatch(card: UnmatchedCard): MatchResult | null {
    const oppositeSide: CardSide = card.side === 'front' ? 'back' : 'front';
    let bestCandidate: UnmatchedCard | null = null;
    let bestScore = 0;
    let bestConfidence: 'exact' | 'fuzzy' | 'side-only' = 'side-only';

    // Count opposite-side cards for side-only fallback
    let oppositeSideCount = 0;
    let lastOpposite: UnmatchedCard | null = null;

    for (const existing of this.cards.values()) {
      if (existing.side !== oppositeSide) continue;
      oppositeSideCount++;
      lastOpposite = existing;

      let score = 0;
      let cardNumberMatched = false;
      let playerMatched = false;
      let teamMatched = false;

      // Card number match
      if (card.cardNumber && existing.cardNumber) {
        if (card.cardNumber.toLowerCase().trim() === existing.cardNumber.toLowerCase().trim()) {
          score += 2000;
          cardNumberMatched = true;
        }
      }

      // Player name match
      if (card.player && existing.player) {
        const pm = playerNamesMatch(card.player, existing.player);
        if (pm.match) {
          score += pm.exact ? 1000 : 400;
          playerMatched = true;
        } else {
          // Both cards have player names but they don't match —
          // strong signal these are different cards
          score -= 1000;
        }
      }

      // Team name match
      if (card.team && existing.team) {
        const tm = teamNamesMatch(card.team, existing.team);
        if (tm.match) {
          score += tm.exact ? 500 : 200;
          teamMatched = true;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = existing;
        if (cardNumberMatched && (playerMatched || teamMatched)) {
          bestConfidence = 'exact';
        } else if (playerMatched || teamMatched) {
          bestConfidence = 'fuzzy';
        } else {
          bestConfidence = 'side-only';
        }
      }
    }

    // If we found a scored match (player or team matched), use it
    if (bestCandidate && bestScore >= 200) {
      const front = card.side === 'front' ? card : bestCandidate;
      const back = card.side === 'back' ? card : bestCandidate;
      debug(`Match found (${bestConfidence}, score: ${bestScore}): ${cardLabel(front)} <-> ${cardLabel(back)}`);
      return { front, back, confidence: bestConfidence };
    }

    // Side-only fallback: if exactly one opposite-side card exists
    // and neither card has extractable identity, pair them
    if (oppositeSideCount === 1 && lastOpposite) {
      const noIdentityNew = !card.player && !card.team && !card.cardNumber;
      const noIdentityExisting = !lastOpposite.player && !lastOpposite.team && !lastOpposite.cardNumber;
      if (noIdentityNew && noIdentityExisting) {
        const front = card.side === 'front' ? card : lastOpposite;
        const back = card.side === 'back' ? card : lastOpposite;
        debug(`Side-only match (no identity on either card): ${cardLabel(front)} <-> ${cardLabel(back)}`);
        return { front, back, confidence: 'side-only' };
      }
    }

    return null;
  }

  /**
   * OCR fallback: run EasyOCR on the new card and check if any opposite-side
   * pool card's player name appears in the raw text (and vice versa).
   */
  private async findMatchWithOCR(card: UnmatchedCard): Promise<MatchResult | null> {
    // Ensure the new card has cached OCR text
    if (!card.ocrText && this.ocrResolver) {
      try {
        const result = await this.ocrResolver(card.path);
        if (result) {
          card.ocrText = result.text.toLowerCase();
          card.ocrWords = result.words.map(w => w.toLowerCase().trim());
        }
      } catch {
        // OCR failed — degrade gracefully
      }
    }

    const oppositeSide: CardSide = card.side === 'front' ? 'back' : 'front';
    let bestCandidate: UnmatchedCard | null = null;
    let bestScore = 0;

    for (const existing of this.cards.values()) {
      if (existing.side !== oppositeSide) continue;

      // Ensure pool card has cached OCR text
      if (!existing.ocrText && this.ocrResolver) {
        try {
          const result = await this.ocrResolver(existing.path);
          if (result) {
            existing.ocrText = result.text.toLowerCase();
            existing.ocrWords = result.words.map(w => w.toLowerCase().trim());
          }
        } catch {
          // OCR failed — skip this card's OCR check
        }
      }

      let score = 0;
      let ocrNameMatched = false;

      // Check: does the pool card's player name appear in the new card's OCR text?
      if (existing.player && card.ocrText && card.ocrWords) {
        if (nameFoundInOcrText(existing.player, card.ocrText, card.ocrWords)) {
          score += 800;
          ocrNameMatched = true;
        }
      }

      // Check: does the new card's player name appear in the pool card's OCR text?
      if (card.player && existing.ocrText && existing.ocrWords) {
        if (nameFoundInOcrText(card.player, existing.ocrText, existing.ocrWords)) {
          score += 800;
          ocrNameMatched = true;
        }
      }

      // Also check card number (same logic as findMatch)
      if (card.cardNumber && existing.cardNumber) {
        if (card.cardNumber.toLowerCase().trim() === existing.cardNumber.toLowerCase().trim()) {
          score += 2000;
        }
      }

      // Also check team (same logic as findMatch)
      if (card.team && existing.team) {
        const tm = teamNamesMatch(card.team, existing.team);
        if (tm.match) {
          score += tm.exact ? 500 : 200;
        }
      }

      if (ocrNameMatched && score > bestScore) {
        bestScore = score;
        bestCandidate = existing;
      }
    }

    if (bestCandidate && bestScore >= 200) {
      const front = card.side === 'front' ? card : bestCandidate;
      const back = card.side === 'back' ? card : bestCandidate;
      debug(`OCR fallback match (score: ${bestScore}): ${cardLabel(front)} <-> ${cardLabel(back)}`);
      return { front, back, confidence: 'fuzzy' };
    }

    return null;
  }

  /**
   * Get all cards currently in the pool (for reporting on completion).
   */
  getAll(): UnmatchedCard[] {
    return Array.from(this.cards.values());
  }
}
