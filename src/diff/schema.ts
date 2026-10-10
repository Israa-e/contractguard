import { isObject, type RefResolver } from '../refs.js';
import type { ChangeKind, Direction, RawChange, SchemaObject } from '../types.js';

export interface SchemaDiffContext {
  endpoint: string;
  /** Where the schema lives, e.g. "response 200 (application/json)" */
  where: string;
  direction: Direction;
  oldRefs: RefResolver;
  newRefs: RefResolver;
  emit: (change: RawChange) => void;
}

interface NormalizedSchema {
  raw: SchemaObject;
  ref?: string;
  /** null means "any type" (no type constraint). Never contains "null"; see `nullable`. */
  types: Set<string> | null;
  nullable: boolean;
  properties: Record<string, SchemaObject>;
  required: Set<string>;
  enum?: unknown[];
}

/** Constraints where a larger value accepts more input. */
const UPPER_BOUNDS = ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'] as const;
/** Constraints where a smaller value accepts more input. */
const LOWER_BOUNDS = ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'] as const;
/** Constraints that restrict input when present but aren't ordered. */
const UNORDERED = ['pattern', 'format', 'multipleOf'] as const;

export function diffSchema(
  oldSchema: unknown,
  newSchema: unknown,
  ctx: SchemaDiffContext,
  path: string[] = [],
  stack: ReadonlySet<string> = new Set(),
): void {
  const a = normalize(oldSchema, ctx.oldRefs, ctx.direction);
  const b = normalize(newSchema, ctx.newRefs, ctx.direction);

  // Recursive schemas (a Category with child Categories) would otherwise loop forever.
  if (a.ref && b.ref) {
    const key = `${a.ref}|${b.ref}`;
    if (stack.has(key)) return;
    stack = new Set(stack).add(key);
  }

  const emit = (kind: ChangeKind, extra: Partial<RawChange> = {}) =>
    ctx.emit({
      kind,
      endpoint: ctx.endpoint,
      location: formatLocation(ctx.where, path),
      direction: ctx.direction,
      ...extra,
    });

  const typesComparable = diffTypes(a, b, emit);
  diffNullable(a, b, emit);
  diffEnum(a, b, emit);
  diffConstraints(a.raw, b.raw, emit);

  if (!typesComparable) return;

  if (hasType(a, 'object') && hasType(b, 'object')) {
    diffProperties(a, b, ctx, path, stack);
    if (isObject(a.raw.additionalProperties) && isObject(b.raw.additionalProperties)) {
      diffSchema(a.raw.additionalProperties, b.raw.additionalProperties, ctx, [...path, '{*}'], stack);
    }
  }

  if (hasType(a, 'array') && hasType(b, 'array') && a.raw.items && b.raw.items) {
    diffSchema(a.raw.items, b.raw.items, ctx, [...path, '[]'], stack);
  }

  diffComposition(a, b, ctx, path, stack, emit);
}

/** Returns false when types are incompatible, so nested comparison would just be noise. */
function diffTypes(a: NormalizedSchema, b: NormalizedSchema, emit: Emit): boolean {
  if (a.types === null && b.types === null) return true;

  const before = describeTypes(a.types);
  const after = describeTypes(b.types);

  if (a.types === null) {
    emit('schema.type.narrowed', { before, after });
    return true;
  }
  if (b.types === null) {
    emit('schema.type.widened', { before, after });
    return true;
  }

  const added = [...b.types].filter((t) => !coversType(a.types!, t));
  const removed = [...a.types].filter((t) => !coversType(b.types!, t));

  if (added.length && removed.length) {
    emit('schema.type.changed', { before, after });
    return [...a.types].some((t) => b.types!.has(t));
  }
  if (added.length) emit('schema.type.widened', { before, after });
  if (removed.length) emit('schema.type.narrowed', { before, after });
  return true;
}

/** `number` accepts every `integer`, so integer → number is a widening, not a change. */
function coversType(types: Set<string>, t: string): boolean {
  return types.has(t) || (t === 'integer' && types.has('number'));
}

function diffNullable(a: NormalizedSchema, b: NormalizedSchema, emit: Emit): void {
  if (!a.nullable && b.nullable) emit('schema.nullable.added');
  if (a.nullable && !b.nullable) emit('schema.nullable.removed');
}

function diffEnum(a: NormalizedSchema, b: NormalizedSchema, emit: Emit): void {
  if (!a.enum && !b.enum) return;
  if (!a.enum) return emit('schema.enum.narrowed', { after: b.enum, detail: { values: b.enum } });
  if (!b.enum) return emit('schema.enum.widened', { before: a.enum, detail: { values: 'any' } });

  const key = (v: unknown) => JSON.stringify(v);
  const oldKeys = new Set(a.enum.map(key));
  const newKeys = new Set(b.enum.map(key));
  const added = b.enum.filter((v) => !oldKeys.has(key(v)));
  const removed = a.enum.filter((v) => !newKeys.has(key(v)));

  if (added.length) emit('schema.enum.widened', { before: a.enum, after: b.enum, detail: { values: added } });
  if (removed.length) emit('schema.enum.narrowed', { before: a.enum, after: b.enum, detail: { values: removed } });
}

function diffConstraints(a: SchemaObject, b: SchemaObject, emit: Emit): void {
  const report = (constraint: string, effect: 'tightened' | 'loosened' | 'changed') =>
    emit(`schema.constraint.${effect}`, { before: a[constraint], after: b[constraint], detail: { constraint } });

  const compareOrdered = (constraint: string, largerIsLooser: boolean) => {
    const before = a[constraint];
    const after = b[constraint];
    if (before === after) return;
    if (before === undefined) return report(constraint, 'tightened');
    if (after === undefined) return report(constraint, 'loosened');
    // OpenAPI 3.0 uses booleans for exclusiveMinimum/Maximum; we can't order those.
    if (typeof before !== 'number' || typeof after !== 'number') return report(constraint, 'changed');
    const looser = largerIsLooser ? after > before : after < before;
    report(constraint, looser ? 'loosened' : 'tightened');
  };

  for (const c of UPPER_BOUNDS) compareOrdered(c, true);
  for (const c of LOWER_BOUNDS) compareOrdered(c, false);

  for (const c of UNORDERED) {
    const before = a[c];
    const after = b[c];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before === undefined) report(c, 'tightened');
    else if (after === undefined) report(c, 'loosened');
    else report(c, 'changed');
  }

  if (a.uniqueItems !== true && b.uniqueItems === true) report('uniqueItems', 'tightened');
  if (a.uniqueItems === true && b.uniqueItems !== true) report('uniqueItems', 'loosened');

  if (a.additionalProperties !== false && b.additionalProperties === false) report('additionalProperties', 'tightened');
  if (a.additionalProperties === false && b.additionalProperties !== false) report('additionalProperties', 'loosened');
}

function diffProperties(
  a: NormalizedSchema,
  b: NormalizedSchema,
  ctx: SchemaDiffContext,
  path: string[],
  stack: ReadonlySet<string>,
): void {
  const emitAt = (name: string, kind: ChangeKind, detail: Record<string, unknown> = {}) =>
    ctx.emit({
      kind,
      endpoint: ctx.endpoint,
      location: formatLocation(ctx.where, [...path, name]),
      direction: ctx.direction,
      detail: { name, ...detail },
    });

  const removed = Object.keys(a.properties).filter((n) => !(n in b.properties));
  const added = Object.keys(b.properties).filter((n) => !(n in a.properties));

  for (const [name, oldProp] of Object.entries(a.properties)) {
    if (!(name in b.properties)) {
      emitAt(name, 'schema.property.removed', {
        wasRequired: a.required.has(name),
        additionalPropertiesForbidden: b.raw.additionalProperties === false,
        renamedTo: guessRename(name, removed, added, a, b, ctx),
      });
      continue;
    }
    if (!a.required.has(name) && b.required.has(name)) emitAt(name, 'schema.required.added');
    if (a.required.has(name) && !b.required.has(name)) emitAt(name, 'schema.required.removed');
    diffSchema(oldProp, b.properties[name], ctx, [...path, name], stack);
  }

  for (const name of Object.keys(b.properties)) {
    if (!(name in a.properties)) emitAt(name, 'schema.property.added', { required: b.required.has(name) });
  }
}

/**
 * A removed property is "probably renamed" when exactly one added property has an
 * identical schema, and that pairing is unambiguous in both directions.
 */
function guessRename(
  name: string,
  removed: string[],
  added: string[],
  a: NormalizedSchema,
  b: NormalizedSchema,
  ctx: SchemaDiffContext,
): string | undefined {
  const fingerprint = (schema: unknown, refs: RefResolver) => {
    const { node } = refs.resolveSchema(schema);
    const { description, example, examples, title, deprecated, ...shape } = node ?? {};
    return JSON.stringify(shape);
  };
  const oldPrint = (n: string) => fingerprint(a.properties[n], ctx.oldRefs);
  const newPrint = (n: string) => fingerprint(b.properties[n], ctx.newRefs);

  const candidates = added.filter((n) => newPrint(n) === oldPrint(name));
  if (candidates.length !== 1) return undefined;
  const rivals = removed.filter((n) => oldPrint(n) === newPrint(candidates[0]));
  return rivals.length === 1 ? candidates[0] : undefined;
}

function diffComposition(
  a: NormalizedSchema,
  b: NormalizedSchema,
  ctx: SchemaDiffContext,
  path: string[],
  stack: ReadonlySet<string>,
  emit: Emit,
): void {
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const before: unknown[] | undefined = a.raw[keyword];
    const after: unknown[] | undefined = b.raw[keyword];
    if (!before && !after) continue;

    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
      emit('schema.composition.changed', {
        detail: { keyword, before: before?.length ?? 0, after: after?.length ?? 0 },
      });
      continue;
    }
    // Same shape: compare branches positionally. Reordering branches will show up as
    // changes inside branches rather than being silently accepted.
    before.forEach((branch, i) => diffSchema(branch, after[i], ctx, [...path, `${keyword}[${i}]`], stack));
  }

  if (JSON.stringify(a.raw.not) !== JSON.stringify(b.raw.not)) {
    emit('schema.composition.changed', { detail: { keyword: 'not' } });
  }
}

type Emit = (kind: ChangeKind, extra?: Partial<RawChange>) => void;

function normalize(schema: unknown, refs: RefResolver, direction: Direction): NormalizedSchema {
  const { raw, ref } = flatten(schema, refs);

  const { types, nullable } = readTypes(raw);

  // readOnly properties don't exist in requests; writeOnly ones don't exist in responses.
  const hidden = direction === 'request' ? 'readOnly' : 'writeOnly';
  const properties: Record<string, SchemaObject> = {};
  for (const [name, prop] of Object.entries(isObject(raw.properties) ? raw.properties : {})) {
    if (flatten(prop, refs).raw[hidden] === true) continue;
    properties[name] = prop as SchemaObject;
  }
  const required = new Set<string>(
    (Array.isArray(raw.required) ? raw.required : []).filter((n: string) => n in properties),
  );

  let enumValues: unknown[] | undefined = Array.isArray(raw.enum) ? raw.enum : undefined;
  if ('const' in raw) enumValues = [raw.const];
  enumValues = enumValues?.filter((v) => v !== null);

  return { raw, ref, types, nullable, properties, required, enum: enumValues };
}

/** Resolves a schema and flattens a top-level `allOf`, giving the keywords that apply to it. */
function flatten(schema: unknown, refs: RefResolver): { raw: SchemaObject; ref?: string } {
  const { node, ref } = refs.resolveSchema(schema ?? {});
  const raw: SchemaObject = node ?? {};
  if (!Array.isArray(raw.allOf)) return { raw, ref };
  // `{ allOf: [{ $ref }, ...] }` stands for that ref in cycle detection; without it, a
  // recursive property declared in several branches would recurse forever.
  const firstRef = raw.allOf.find((part: unknown) => isObject(part) && typeof part.$ref === 'string')?.$ref;
  return { raw: mergeAllOf(raw, refs), ref: ref ?? firstRef };
}

/**
 * Flattens `allOf` into one schema that accepts what every branch accepts: bounds take the
 * strictest value, types and enums are intersected, `required` is unioned, a property declared
 * in several branches combines its schemas, and differing patterns/formats are all kept.
 */
function mergeAllOf(schema: SchemaObject, refs: RefResolver, depth = 0): SchemaObject {
  const { allOf, ...rest } = schema;
  let merged: SchemaObject = rest;
  for (const part of allOf as unknown[]) {
    let resolved = refs.resolveSchema(part).node ?? {};
    if (Array.isArray(resolved.allOf) && depth < 32) resolved = mergeAllOf(resolved, refs, depth + 1);
    merged = intersect(merged, resolved);
  }
  return merged;
}

/** Keywords where any branch saying `true` makes the merged schema say `true`. */
const ANY_TRUE = ['nullable', 'readOnly', 'writeOnly', 'uniqueItems', 'deprecated'];

function intersect(a: SchemaObject, b: SchemaObject): SchemaObject {
  const out: SchemaObject = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (out[key] === undefined) out[key] = value;
    else if (key === 'properties' && isObject(value) && isObject(out[key])) {
      const properties: Record<string, unknown> = { ...out[key] };
      for (const [name, prop] of Object.entries(value)) {
        properties[name] = name in properties ? { allOf: [properties[name], prop] } : prop;
      }
      out[key] = properties;
    } else if (key === 'required' && Array.isArray(value) && Array.isArray(out[key])) {
      out[key] = [...new Set([...out[key], ...value])];
    } else if (key === 'type') out[key] = intersectTypes(out[key], value);
    else if (key === 'enum' && Array.isArray(value) && Array.isArray(out[key])) {
      const keys = new Set(value.map((v) => JSON.stringify(v)));
      out[key] = out[key].filter((v: unknown) => keys.has(JSON.stringify(v)));
    } else if (key === 'items' && isObject(value) && isObject(out[key])) out[key] = { allOf: [out[key], value] };
    else if (key === 'additionalProperties') {
      if (value === false || out[key] === false) out[key] = false;
      else if (isObject(value) && isObject(out[key])) out[key] = { allOf: [out[key], value] };
      else if (isObject(value)) out[key] = value;
    } else if (ANY_TRUE.includes(key)) out[key] = out[key] === true || value === true;
    else if ((UNORDERED as readonly string[]).includes(key)) out[key] = unionValues(out[key], value);
  }
  intersectBound(out, a, b, 'maximum', 'exclusiveMaximum', (x, y) => x < y);
  intersectBound(out, a, b, 'minimum', 'exclusiveMinimum', (x, y) => x > y);
  for (const key of UPPER_BOUNDS) pickNumber(out, a, b, key, Math.min);
  for (const key of LOWER_BOUNDS) pickNumber(out, a, b, key, Math.max);
  return out;
}

/** Both numeric: keep the stricter one. Anything else (3.0 booleans) is handled by `intersectBound`. */
function pickNumber(out: SchemaObject, a: SchemaObject, b: SchemaObject, key: string, pick: typeof Math.min) {
  if (typeof a[key] === 'number' && typeof b[key] === 'number') out[key] = pick(a[key], b[key]);
}

/**
 * In OpenAPI 3.0, `exclusiveMaximum: true` modifies `maximum`, so the flag follows whichever
 * branch supplies the stricter bound (either flag when the bounds are equal). `false` is the
 * default, so it is dropped rather than written. 3.1's numeric form is an ordinary bound.
 */
function intersectBound(
  out: SchemaObject,
  a: SchemaObject,
  b: SchemaObject,
  bound: string,
  exclusive: string,
  stricter: (x: number, y: number) => boolean,
) {
  if (typeof a[exclusive] !== 'boolean' && typeof b[exclusive] !== 'boolean') return;
  const aHas = typeof a[bound] === 'number';
  const bHas = typeof b[bound] === 'number';
  if (!aHas && !bHas) return;

  const flag = (s: SchemaObject) => s[exclusive] === true;
  let exclusiveResult: boolean;
  if (!aHas || !bHas) exclusiveResult = flag(aHas ? a : b);
  else if (stricter(b[bound], a[bound])) exclusiveResult = flag(b);
  else if (stricter(a[bound], b[bound])) exclusiveResult = flag(a);
  else exclusiveResult = flag(a) || flag(b);

  if (exclusiveResult) out[exclusive] = true;
  else delete out[exclusive];
}

/** `integer` is the intersection of `integer` and `number`. An empty intersection keeps `a`. */
function intersectTypes(a: unknown, b: unknown): unknown {
  const list = (t: unknown): string[] => (Array.isArray(t) ? t : typeof t === 'string' ? [t] : []);
  const other = new Set(list(b));
  const common = list(a).flatMap((t) => {
    if (other.has(t)) return [t];
    if (t === 'integer' && other.has('number')) return ['integer'];
    if (t === 'number' && other.has('integer')) return ['integer'];
    return [];
  });
  const unique = [...new Set(common)];
  if (unique.length === 0) return a;
  return unique.length === 1 ? unique[0] : unique;
}

/** Differing unordered constraints (two patterns) all apply, so keep every distinct value. */
function unionValues(a: unknown, b: unknown): unknown {
  const values = [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
  const unique = values.filter((v, i) => values.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i);
  return unique.length === 1 ? unique[0] : unique;
}

function readTypes(schema: SchemaObject): { types: Set<string> | null; nullable: boolean } {
  const raw = schema.type;
  let list: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  let nullable = schema.nullable === true || list.includes('null');
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) nullable = true;

  list = list.filter((t) => t !== 'null');
  if (list.length === 0) {
    if (isObject(schema.properties)) list = ['object'];
    else if (schema.items !== undefined) list = ['array'];
  }
  return { types: list.length ? new Set(list) : null, nullable };
}

function hasType(s: NormalizedSchema, type: string): boolean {
  return s.types === null || s.types.has(type);
}

function describeTypes(types: Set<string> | null): string {
  return types === null ? 'any' : [...types].sort().join(' | ');
}

export function formatLocation(where: string, path: string[]): string {
  if (path.length === 0) return where;
  const joined = path.reduce((acc, seg) => (seg === '[]' || acc === '' ? acc + seg : `${acc}.${seg}`), '');
  return `${where} → ${joined}`;
}
