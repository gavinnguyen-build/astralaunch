/**
 * Token image URLs. Uploaded images are served by the API as /img/<hash>-<64|256|512>.webp (content-addressed,
 * immutable). An older token may only have an https imageUrl; nothing else is ever used as an image source.
 */
import { tokenImagePath, type TokenImageSize } from '@astralaunch/shared';
import { API_BASE } from '../env.js';

export type ImageRef = { imageHash?: string | null; imageUrl?: string | null } | null | undefined;

export function tokenImageSrc(t: ImageRef, size: TokenImageSize): string | null {
  if (t?.imageHash) return `${API_BASE}${tokenImagePath(t.imageHash, size)}`;
  if (t?.imageUrl && /^https:\/\//.test(t.imageUrl)) return t.imageUrl;
  return null;
}

export const IMAGE_ERROR = 'Use a PNG, JPG or WebP under 2 MB';

/** Upload one image file. Resolves to its content hash; rejects with one plain sentence. */
export async function uploadTokenImage(file: Blob): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 2 * 1024 * 1024) throw new Error(IMAGE_ERROR);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/uploads/token-image`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  } catch {
    throw new Error('The upload failed. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({})) as { hash?: string; error?: string };
  if (res.status === 429) throw new Error(body.error ?? 'Too many uploads. Try again in a few minutes.');
  if (!res.ok || !body.hash) throw new Error(body.error ?? IMAGE_ERROR);
  return body.hash;
}
