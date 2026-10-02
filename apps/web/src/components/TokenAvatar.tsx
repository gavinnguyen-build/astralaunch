/**
 * Token avatar: the uploaded image (64 px rendition for small avatars, 256 px for large) over the
 * initial-letter tile, which stays visible when there is no image or it fails to load.
 */
import { useState, type CSSProperties } from 'react';
import { tokenImageSrc, type ImageRef } from '../lib/tokenImage.js';

export function TokenAvatar({ token, initial, background, size, radius, fontSize, style }: {
  token: ImageRef; initial: string; background: string; size: number; radius: number; fontSize?: number; style?: CSSProperties;
}) {
  const src = tokenImageSrc(token, size > 64 ? 256 : 64);
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = !!src && failed !== src;
  return (
    <span aria-hidden="true" style={{
      position: 'relative', flexShrink: 0, width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px`, overflow: 'hidden',
      background, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `${fontSize ?? Math.round(size * 0.42)}px`, fontWeight: 800, color: '#FFFFFF', ...style,
    }}>
      {initial}
      {showImg ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
    </span>
  );
}
