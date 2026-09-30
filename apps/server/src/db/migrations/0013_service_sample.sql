-- Migration 0013: optional sample request per service (docs/decisions.md D-SL10). NULL sample_method = the pasted
-- link is checked with a plain GET. With POST, sample_body is the JSON body (<= 16 KB). Used by the link check and
-- the token page's "Try a sample call". response_kind stays NULL when there is no sample call.
ALTER TABLE services ADD COLUMN IF NOT EXISTS sample_method TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS sample_body   TEXT;
