/**
 * Response schema check before settle (SPEC §9: upstream 2xx AND schema pass → settle).
 * Schemas are written by service creators, i.e. untrusted, so they are interpreted by
 * @cfworker/json-schema (no code generation), never compiled to code.
 */
import { Validator, type Schema, type SchemaDraft } from '@cfworker/json-schema';

export type SchemaCheck =
  | { ok: true }
  | { ok: false; code: 'response_not_json' | 'schema_mismatch' | 'schema_invalid'; detail: string };

const DRAFTS: [RegExp, SchemaDraft][] = [[/2020-12/, '2020-12'], [/2019-09/, '2019-09'], [/draft-07/, '7'], [/draft-04/, '4']];
const cache = new Map<string, Validator>();

/** Parse + construct a validator. Throws with a readable message if the schema is unusable. */
export function compileResponseSchema(text: string): Validator {
  const hit = cache.get(text);
  if (hit) return hit;
  let schema: unknown;
  try { schema = JSON.parse(text); } catch { throw new Error('responseSchema is not valid JSON'); }
  if (typeof schema !== 'boolean' && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) {
    throw new Error('responseSchema must be a JSON Schema object');
  }
  const decl = typeof schema === 'object' ? String((schema as { $schema?: unknown }).$schema ?? '') : '';
  const draft = DRAFTS.find(([re]) => re.test(decl))?.[1] ?? '2020-12';
  let v: Validator;
  try {
    v = new Validator(schema as Schema, draft, false);
    v.validate(null);   // surfaces malformed keywords / unresolvable $refs now, not at call time
  } catch (e) {
    throw new Error(`responseSchema cannot be used: ${(e as Error).message}`);
  }
  if (cache.size >= 500) cache.clear();
  cache.set(text, v);
  return v;
}

/** Check an upstream body against the service's responseSchema (null schema = nothing to check). */
export function checkResponse(schemaText: string | null | undefined, body: Uint8Array): SchemaCheck {
  if (!schemaText) return { ok: true };
  let v: Validator;
  try { v = compileResponseSchema(schemaText); } catch (e) { return { ok: false, code: 'schema_invalid', detail: (e as Error).message }; }
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return { ok: false, code: 'response_not_json', detail: 'upstream response is not JSON' }; }
  const r = v.validate(json);
  if (r.valid) return { ok: true };
  const first = r.errors[0];
  return { ok: false, code: 'schema_mismatch', detail: first ? `${first.instanceLocation}: ${first.error}`.slice(0, 300) : 'does not match' };
}
