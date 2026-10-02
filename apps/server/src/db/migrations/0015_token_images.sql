-- Migration 0015: uploaded token images. Files live on a volume (IMAGE_STORE_DIR) by content hash;
-- this table tracks uploads so unreferenced ones can be deleted after 24 h. tokens.image_hash is set by
-- the creator-signed token details (metadata / launch-details).
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_hash TEXT;
CREATE TABLE IF NOT EXISTS token_images (
  hash        TEXT PRIMARY KEY,
  bytes       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tokens_image_hash_idx ON tokens (image_hash);
