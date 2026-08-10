import sharp from 'sharp';

/**
 * Perceptual "difference hash" (dHash) for cheap near-duplicate detection.
 *
 * The image is reduced to a 9×8 grayscale thumbnail and each pixel is compared
 * to its right-hand neighbour, yielding 64 bits (8 comparisons × 8 rows). Two
 * scans of the same physical card side produce near-identical hashes regardless
 * of minor crop/rotation/lighting differences, while genuinely different images
 * (e.g. a front vs. a back) differ by a large Hamming distance.
 *
 * Cost is trivial — sharp/libvips streams the decode and we only keep a 72-byte
 * thumbnail, so this carries none of the memory profile of the ML models that
 * previously caused OOM crashes.
 */
export async function computeDHash(imagePath: string): Promise<bigint> {
  // 9 wide so each of the 8 rows yields 8 left>right comparisons.
  const data = await sharp(imagePath)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();

  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      if (left > right) hash |= 1n << bit;
      bit++;
    }
  }
  return hash;
}

/** Number of differing bits between two 64-bit hashes (0 = identical). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * Hamming distance at or below which two dHashes are treated as the same
 * physical image. Same-scan pairs typically land at 0–4; a front vs. its back
 * is usually 25+, so 10 separates re-scans from genuinely different sides with
 * comfortable margin.
 */
export const SAME_IMAGE_THRESHOLD = 10;
