/**
 * Token images: validation, processing and storage (content-addressed, on a persistent volume).
 *
 * Accepted: PNG, JPEG, WebP (checked by magic bytes AND by the decoder's detected format; never SVG or
 * anything else), at most 2 MB. Decoded with sharp (pixel limit), EXIF-oriented, centre-cropped to a square
 * and written as 64 / 256 / 512 px WebP. sharp writes no metadata unless asked, so EXIF / GPS / XMP / ICC
 * from the upload are dropped. Files: <IMAGE_STORE_DIR>/<hash>-<size>.webp, hash = sha256(upload)[0..40].
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { TOKEN_IMAGE_SIZES, tokenImagePath, type TokenImageSize } from '@astralaunch/shared';
import { tokenImages, tokens } from '../db/schema.js';
import type { Db } from './launchFee.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Decoder guard against decompression bombs (a 2 MB file can still claim huge dimensions). */
const MAX_INPUT_PIXELS = 40_000_000;
export const UNREFERENCED_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_ERROR = 'Use a PNG, JPG or WebP under 2 MB';

export class ImageInputError extends Error {
  constructor(message = IMAGE_ERROR, readonly status: 400 | 413 | 415 = 415) { super(message); }
}

export function imageStoreDir(): string {
  return path.resolve(process.env.IMAGE_STORE_DIR || './data/images');
}

/** Format from the file's magic bytes (the extension and Content-Type are ignored). */
export function sniffImage(b: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export const imageHashOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 40);

/** Validate + render the three square WebP sizes. Throws ImageInputError for anything not acceptable. */
export async function processTokenImage(input: Uint8Array): Promise<{ hash: string; files: Record<TokenImageSize, Buffer> }> {
  if (input.byteLength > MAX_IMAGE_BYTES) throw new ImageInputError(IMAGE_ERROR, 413);
  const kind = sniffImage(input);
  if (!kind) throw new ImageInputError();
  const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const, animated: false };
  let meta: sharp.Metadata;
  try { meta = await sharp(input, opts).metadata(); } catch { throw new ImageInputError(); }
  // The decoder must agree with the magic bytes (no polyglots, no SVG / TIFF / HEIF / GIF).
  if (meta.format !== kind || !meta.width || !meta.height) throw new ImageInputError();
  const base = sharp(input, opts).rotate();   // apply EXIF orientation; the output carries no metadata
  const files = {} as Record<TokenImageSize, Buffer>;
  try {
    for (const size of TOKEN_IMAGE_SIZES) {
      files[size] = await base.clone().resize(size, size, { fit: 'cover', position: 'centre' }).webp({ quality: 86 }).toBuffer();
    }
  } catch { throw new ImageInputError(); }
  return { hash: imageHashOf(input), files };
}

const fileName = (hash: string, size: TokenImageSize) => path.basename(tokenImagePath(hash, size));

/** Store the renditions (idempotent, atomic per file) and record the upload. */
export async function storeTokenImage(db: Db, hash: string, files: Record<TokenImageSize, Buffer>, bytes: number, dir = imageStoreDir()) {
  await mkdir(dir, { recursive: true });
  for (const size of TOKEN_IMAGE_SIZES) {
    const dest = path.join(dir, fileName(hash, size));
    const exists = await stat(dest).then(() => true, () => false);
    if (exists) continue;
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, files[size]);
    await rename(tmp, dest);
  }
  await db.insert(tokenImages).values({ hash, bytes }).onConflictDoUpdate({ target: tokenImages.hash, set: { createdAt: sql`NOW()` } });
}

/** True if the hash is a stored upload (required before a token may reference it). */
export async function tokenImageExists(db: Db, hash: string): Promise<boolean> {
  const [row] = await db.select({ hash: tokenImages.hash }).from(tokenImages).where(eq(tokenImages.hash, hash)).limit(1);
  return !!row;
}

export async function readTokenImage(name: string, dir = imageStoreDir()): Promise<Buffer | null> {
  if (!/^[0-9a-f]{40}-(64|256|512)\.webp$/.test(name)) return null;
  return readFile(path.join(dir, name)).catch(() => null);
}

/** Delete uploads older than 24 h that no token references (rows and files). Returns the deleted hashes. */
export async function cleanupUnreferencedImages(db: Db, nowMs = Date.now(), dir = imageStoreDir()): Promise<string[]> {
  const cutoff = new Date(nowMs - UNREFERENCED_TTL_MS);
  const stale = await db.select({ hash: tokenImages.hash }).from(tokenImages)
    .leftJoin(tokens, eq(tokens.imageHash, tokenImages.hash))
    .where(and(lt(tokenImages.createdAt, cutoff), isNull(tokens.asset)));
  const deleted: string[] = [];
  for (const { hash } of stale) {
    for (const size of TOKEN_IMAGE_SIZES) await rm(path.join(dir, fileName(hash, size)), { force: true });
    await db.delete(tokenImages).where(eq(tokenImages.hash, hash));
    deleted.push(hash);
  }
  return deleted;
}
