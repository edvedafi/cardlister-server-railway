import path from 'path';
import { createLogger } from './logger.js';
import { hammingDistance, SAME_IMAGE_THRESHOLD } from './imageHash.js';

const debug = createLogger('card-pool');

/** Get a display name for a card — prefer originalFilename, fall back to path basename. */
function cardLabel(card: UnmatchedCard): string {
  const name = card.originalFilename ?? path.basename(card.path);
  const player = card.player ?? 'unknown';
  return `${player} (${name})`;
}

/** Raw identity fields for a card, for diagnostic logging. */
function cardIdentity(card: UnmatchedCard): string {
  return `player=${card.player ?? 'null'} team=${card.team ?? 'null'} cardNumber=${card.cardNumber ?? 'null'}`;
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
  imageHash?: bigint; // cached perceptual dHash, lazily computed on a same-side collision
}

/**
 * Stable identity for pair bans. Prefer the pre-crop source: the review menu
 * can hand back a re-cropped temp path, so `path` alone would let a banned
 * pair slip through after a re-crop.
 */
function banIdentity(card: UnmatchedCard): string {
  return card.originalPath ?? card.originalFilename ?? card.path;
}

function banKey(a: UnmatchedCard, b: UnmatchedCard): string {
  return [banIdentity(a), banIdentity(b)].sort().join('\u0000');
}

export type OcrTextResolver = (imagePath: string) => Promise<{ text: string; words: string[] } | null>;

/** Resolves an image's perceptual hash; returns null when hashing isn't possible. */
export type ImageHasher = (imagePath: string) => Promise<bigint | null>;

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

  // Single-word name vs full name: many card fronts print only the surname
  // ("BUEHLER") while the back carries the full name ("Walker Buehler").
  // The last names already matched above, so with no first name to contradict
  // it, treat this as a (non-exact) match.
  if (partsA.length === 1 || partsB.length === 1) {
    return { match: true, exact: false };
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
 * Strict "is this a confirmed duplicate" check — requires BOTH player and
 * cardNumber to match. Used to auto-remove redundant queued review jobs;
 * deliberately stricter than sameCardIdentity's OR-fallback (which is tuned
 * for pool pairing, not destructive removal) — missing data must never be
 * treated as proof of duplication.
 */
export function playerAndCardNumberMatch(
  a: { player: string | null; cardNumber: string | null },
  b: { player: string | null; cardNumber: string | null },
): boolean {
  if (!a.player || !b.player || !a.cardNumber || !b.cardNumber) return false;
  if (!playerNamesMatch(a.player, b.player).match) return false;
  return a.cardNumber.toLowerCase().trim() === b.cardNumber.toLowerCase().trim();
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
 * Decide whether two cards refer to the same card for collision purposes.
 * Player name is the strongest signal (large, clearly-OCR'd text) and is
 * authoritative when both sides have one — an explicit disagreement there
 * must not be overridden by a coincidentally-equal card number, which is a
 * much more error-prone read (especially misreads leaking through from
 * front-side images). Card number and team are only consulted as fallbacks
 * when at least one side lacks a player name.
 */
function sameCardIdentity(a: UnmatchedCard, b: UnmatchedCard): boolean {
  if (a.player && b.player) {
    return playerNamesMatch(a.player, b.player).match;
  }

  if (
    a.cardNumber &&
    b.cardNumber &&
    a.cardNumber.toLowerCase().trim() === b.cardNumber.toLowerCase().trim()
  ) {
    return true;
  }

  if (a.team && b.team && teamNamesMatch(a.team, b.team).match) return true;

  return false;
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
  // Pairs the operator explicitly separated in review. Both images stay in the
  // pool looking for their real partners, so without this they would just
  // re-match each other and reopen the review we were told is wrong.
  private banned = new Set<string>();
  private ocrResolver: OcrTextResolver | null;
  private imageHasher: ImageHasher | null;

  constructor(ocrResolver?: OcrTextResolver, imageHasher?: ImageHasher) {
    this.ocrResolver = ocrResolver ?? null;
    this.imageHasher = imageHasher ?? null;
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
   * Never match these two images with each other again. Set when the review
   * menu reports an auto-matched pair is actually two different cards.
   */
  banPair(a: UnmatchedCard, b: UnmatchedCard): void {
    this.banned.add(banKey(a, b));
    debug(`Banned pair: ${cardLabel(a)} <-> ${cardLabel(b)}`);
  }

  private isBanned(a: UnmatchedCard, b: UnmatchedCard): boolean {
    return this.banned.size > 0 && this.banned.has(banKey(a, b));
  }

  /**
   * Resolve a collision where `card` shares the same side + identity (card
   * number, player, or team) as a card already waiting in the pool.
   *
   * Front/back classification is sometimes wrong, so two *different* images of
   * the same card can both arrive labelled the same side. We must not overwrite
   * the image already in the pool. Instead:
   *   - If the two images are the *same* physical scan (a deliberate re-scan),
   *     keep the newer one — evict the stale entry (newer-wins, as before).
   *   - If the images differ, the new one was mis-classified: flip its side so
   *     it pairs with the existing card instead of clobbering it.
   *
   * When no image hasher is available (or hashing fails) we can't tell the two
   * cases apart, so we fall back to the legacy newer-wins behaviour.
   */
  private async resolveSameSideCollision(card: UnmatchedCard): Promise<void> {
    if (!card.player && !card.team && !card.cardNumber) return;

    for (const existing of this.cards.values()) {
      if (existing.side !== card.side) continue;
      if (existing.path === card.path) continue;
      if (!sameCardIdentity(card, existing)) continue;

      if (await this.imagesAreSame(card, existing)) {
        debug(`Same-image re-scan: replacing ${cardLabel(existing)} with ${cardLabel(card)}`);
        debug(`  existing: ${cardIdentity(existing)}`);
        debug(`  incoming: ${cardIdentity(card)}`);
        this.cards.delete(existing.path);
      } else {
        const flipped: CardSide = card.side === 'front' ? 'back' : 'front';
        debug(`Same-side collision with a different image — flipping ${cardLabel(card)} ${card.side} → ${flipped} (keeping ${cardLabel(existing)})`);
        debug(`  existing: ${cardIdentity(existing)}`);
        debug(`  incoming: ${cardIdentity(card)}`);
        card.side = flipped;
      }
      return;
    }
  }

  /**
   * Compare two cards' images via perceptual hash. Returns true when they look
   * like the same physical scan. Without a working hasher we conservatively
   * return true so behaviour matches the pre-safety-net newer-wins logic.
   */
  private async imagesAreSame(a: UnmatchedCard, b: UnmatchedCard): Promise<boolean> {
    if (!this.imageHasher) return true;
    const ha = await this.ensureHash(a);
    const hb = await this.ensureHash(b);
    if (ha === null || hb === null) return true;
    return hammingDistance(ha, hb) <= SAME_IMAGE_THRESHOLD;
  }

  /** Lazily compute and cache a card's perceptual hash. */
  private async ensureHash(card: UnmatchedCard): Promise<bigint | null> {
    if (card.imageHash !== undefined) return card.imageHash;
    if (!this.imageHasher) return null;
    try {
      const hash = await this.imageHasher(card.path);
      if (hash !== null) card.imageHash = hash;
      return hash;
    } catch {
      return null;
    }
  }

  /**
   * Add a card to the pool and attempt to find a matching counterpart.
   * Returns a MatchResult if a match is found, or null if the card is held.
   */
  async addCard(card: UnmatchedCard): Promise<MatchResult | null> {
    // Resolve same-side collisions before matching: a re-scan replaces the
    // stale entry, while a mis-classified different image is flipped so it can
    // pair instead of overwriting the image already in the pool.
    await this.resolveSameSideCollision(card);

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
      // Checked before the side-only tally so a banned partner can't win the
      // "exactly one opposite-side card" fallback either.
      if (this.isBanned(card, existing)) continue;
      oppositeSideCount++;
      lastOpposite = existing;

      // Player name is the strongest, least error-prone signal. If both cards
      // have one and they explicitly disagree, this candidate cannot be a
      // match — a coincidentally-equal card number (which can leak in from
      // misread front-side text) must never override that disagreement.
      if (card.player && existing.player && !playerNamesMatch(card.player, existing.player).match) {
        debug(`Rejecting candidate (player mismatch): ${cardIdentity(card)} vs ${cardIdentity(existing)}`);
        continue;
      }

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
      debug(`  front: ${cardIdentity(front)}`);
      debug(`  back:  ${cardIdentity(back)}`);
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
      if (this.isBanned(card, existing)) continue;

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
