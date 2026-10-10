import { RefResolver, isObject } from '../refs.js';
import type { Direction, OpenAPIObject, RawChange } from '../types.js';
import { diffSchema } from './schema.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface Context {
  oldRefs: RefResolver;
  newRefs: RefResolver;
  emit: (change: RawChange) => void;
}

/** Produces every structural difference between two OpenAPI documents. */
export function diffSpecs(oldDoc: OpenAPIObject, newDoc: OpenAPIObject): RawChange[] {
  const changes: RawChange[] = [];
  const ctx: Context = {
    oldRefs: new RefResolver(oldDoc),
    newRefs: new RefResolver(newDoc),
    emit: (c) => changes.push(c),
  };

  // "/orders/{id}" and "/orders/{orderId}" are the same endpoint to a client.
  const newPaths = new Map(Object.keys(newDoc.paths).map((p) => [normalizePath(p), p]));
  const matchedNewPaths = new Set<string>();

  for (const oldPath of Object.keys(oldDoc.paths)) {
    const newPath = newPaths.get(normalizePath(oldPath));
    if (newPath) matchedNewPaths.add(newPath);

    const oldItem = ctx.oldRefs.resolve(oldDoc.paths[oldPath]).node ?? {};
    const newItem = newPath ? (ctx.newRefs.resolve(newDoc.paths[newPath]).node ?? {}) : {};

    for (const method of METHODS) {
      const oldOp = oldItem[method];
      const newOp = newItem[method];
      if (!isObject(oldOp) && !isObject(newOp)) continue;

      if (isObject(oldOp) && !isObject(newOp)) {
        ctx.emit({
          kind: 'endpoint.removed',
          endpoint: label(method, oldPath),
          location: 'operation',
          detail: { deprecated: oldOp.deprecated === true },
        });
      } else if (!isObject(oldOp)) {
        ctx.emit({ kind: 'endpoint.added', endpoint: label(method, newPath!), location: 'operation' });
      } else {
        diffOperation(
          { op: oldOp, item: oldItem, path: oldPath, doc: oldDoc },
          { op: newOp, item: newItem, path: newPath!, doc: newDoc },
          label(method, oldPath),
          ctx,
        );
      }
    }
  }

  for (const newPath of Object.keys(newDoc.paths)) {
    if (matchedNewPaths.has(newPath)) continue;
    const item = ctx.newRefs.resolve(newDoc.paths[newPath]).node ?? {};
    for (const method of METHODS) {
      if (isObject(item[method])) {
        ctx.emit({ kind: 'endpoint.added', endpoint: label(method, newPath), location: 'operation' });
      }
    }
  }

  return changes;
}

interface OperationSide {
  op: OpenAPIObject;
  item: OpenAPIObject;
  path: string;
  doc: OpenAPIObject;
}

function diffOperation(a: OperationSide, b: OperationSide, endpoint: string, ctx: Context): void {
  if (a.op.deprecated !== true && b.op.deprecated === true) {
    ctx.emit({ kind: 'endpoint.deprecated', endpoint, location: 'operation' });
  }
  if (a.op.operationId && b.op.operationId && a.op.operationId !== b.op.operationId) {
    ctx.emit({
      kind: 'operation.id.changed',
      endpoint,
      location: 'operationId',
      before: a.op.operationId,
      after: b.op.operationId,
    });
  }

  diffParameters(a, b, endpoint, ctx);
  diffRequestBody(a.op.requestBody, b.op.requestBody, endpoint, ctx);
  diffResponses(a.op.responses, b.op.responses, endpoint, ctx);
  diffSecurity(a, b, endpoint, ctx);
}

// ---------------------------------------------------------------- parameters

interface Param {
  key: string;
  name: string;
  in: string;
  required: boolean;
  schema: unknown;
}

function collectParameters(side: OperationSide, refs: RefResolver): Map<string, Param> {
  const params = new Map<string, Param>();
  const pathParamNames = [...side.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

  // Operation-level parameters override path-level ones with the same name + location.
  for (const raw of [...(side.item.parameters ?? []), ...(side.op.parameters ?? [])]) {
    const p = refs.resolve(raw).node;
    if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;

    // Path params match by position so renaming {id} → {orderId} isn't reported.
    let key: string;
    if (p.in === 'path') {
      const index = pathParamNames.indexOf(p.name);
      key = `path#${index >= 0 ? index : p.name}`;
    } else if (p.in === 'header') {
      key = `header:${p.name.toLowerCase()}`;
    } else {
      key = `${p.in}:${p.name}`;
    }

    const schema = p.schema ?? (isObject(p.content) ? Object.values(p.content)[0]?.schema : undefined);
    params.set(key, { key, name: p.name, in: p.in, required: p.in === 'path' || p.required === true, schema });
  }
  return params;
}

function diffParameters(a: OperationSide, b: OperationSide, endpoint: string, ctx: Context): void {
  const oldParams = collectParameters(a, ctx.oldRefs);
  const newParams = collectParameters(b, ctx.newRefs);
  const where = (p: Param) => `${p.in} parameter "${p.name}"`;

  for (const [key, oldParam] of oldParams) {
    const newParam = newParams.get(key);
    if (!newParam) {
      ctx.emit({ kind: 'parameter.removed', endpoint, location: where(oldParam), detail: { name: oldParam.name } });
      continue;
    }
    if (!oldParam.required && newParam.required) {
      ctx.emit({ kind: 'parameter.required.added', endpoint, location: where(newParam), detail: { name: newParam.name } });
    }
    if (oldParam.required && !newParam.required) {
      ctx.emit({ kind: 'parameter.required.removed', endpoint, location: where(newParam), detail: { name: newParam.name } });
    }
    diffSchema(oldParam.schema, newParam.schema, {
      ...ctx,
      endpoint,
      where: where(newParam),
      direction: 'request',
    });
  }

  for (const [key, newParam] of newParams) {
    if (oldParams.has(key)) continue;
    ctx.emit({
      kind: 'parameter.added',
      endpoint,
      location: where(newParam),
      detail: { name: newParam.name, required: newParam.required },
    });
  }
}

// -------------------------------------------------------------- request body

function diffRequestBody(oldRaw: unknown, newRaw: unknown, endpoint: string, ctx: Context): void {
  const a = ctx.oldRefs.resolve(oldRaw).node;
  const b = ctx.newRefs.resolve(newRaw).node;
  if (!a && !b) return;

  if (!a) {
    ctx.emit({ kind: 'request.body.added', endpoint, location: 'request body', detail: { required: b!.required === true } });
    return;
  }
  if (!b) {
    ctx.emit({ kind: 'request.body.removed', endpoint, location: 'request body' });
    return;
  }

  if (a.required !== true && b.required === true) {
    ctx.emit({ kind: 'request.body.required.added', endpoint, location: 'request body' });
  }
  if (a.required === true && b.required !== true) {
    ctx.emit({ kind: 'request.body.required.removed', endpoint, location: 'request body' });
  }

  diffContent(a.content, b.content, endpoint, 'request body', 'request', ctx);
}

// ----------------------------------------------------------------- responses

function diffResponses(oldRaw: unknown, newRaw: unknown, endpoint: string, ctx: Context): void {
  const a = isObject(oldRaw) ? oldRaw : {};
  const b = isObject(newRaw) ? newRaw : {};

  for (const status of Object.keys(a)) {
    const success = isSuccess(status);
    if (!(status in b)) {
      ctx.emit({ kind: 'response.status.removed', endpoint, location: `response ${status}`, detail: { status, success } });
      continue;
    }
    const oldResponse = ctx.oldRefs.resolve(a[status]).node ?? {};
    const newResponse = ctx.newRefs.resolve(b[status]).node ?? {};
    diffContent(oldResponse.content, newResponse.content, endpoint, `response ${status}`, 'response', ctx);
  }

  for (const status of Object.keys(b)) {
    if (!(status in a)) {
      ctx.emit({
        kind: 'response.status.added',
        endpoint,
        location: `response ${status}`,
        detail: { status, success: isSuccess(status) },
      });
    }
  }
}

function isSuccess(status: string): boolean {
  return /^2/.test(status);
}

// ------------------------------------------------------------------- content

function diffContent(
  oldContent: unknown,
  newContent: unknown,
  endpoint: string,
  where: string,
  direction: Direction,
  ctx: Context,
): void {
  const a = mediaTypes(oldContent);
  const b = mediaTypes(newContent);
  const prefix = direction === 'request' ? 'request' : 'response';

  for (const [type, oldMedia] of a) {
    const newMedia = b.get(type);
    if (!newMedia) {
      ctx.emit({ kind: `${prefix}.mediaType.removed`, endpoint, location: `${where} (${type})`, detail: { mediaType: type } });
      continue;
    }
    diffSchema(oldMedia.schema, newMedia.schema, { ...ctx, endpoint, where: `${where} (${type})`, direction });
  }
  for (const type of b.keys()) {
    if (!a.has(type)) {
      ctx.emit({ kind: `${prefix}.mediaType.added`, endpoint, location: `${where} (${type})`, detail: { mediaType: type } });
    }
  }
}

/** Keys media types without parameters: "application/json; charset=utf-8" → "application/json". */
function mediaTypes(content: unknown): Map<string, OpenAPIObject> {
  const result = new Map<string, OpenAPIObject>();
  if (!isObject(content)) return result;
  for (const [type, media] of Object.entries(content)) {
    result.set(type.split(';')[0].trim().toLowerCase(), isObject(media) ? media : {});
  }
  return result;
}

// ------------------------------------------------------------------ security

/** One alternative of a security requirement: scheme name → required scopes. */
type Requirement = Map<string, Set<string>>;

export const NO_AUTH = 'no authentication';

function effectiveSecurity(side: OperationSide): Requirement[] {
  const raw = side.op.security ?? side.doc.security ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return [new Map()]; // no auth needed
  return raw.filter(isObject).map(
    (alt) => new Map(Object.entries(alt).map(([scheme, scopes]) => [scheme, new Set<string>(Array.isArray(scopes) ? scopes : [])])),
  );
}

/** True if anything satisfying `outer` also satisfies `inner`. */
function isSatisfiedBy(inner: Requirement, outer: Requirement): boolean {
  for (const [scheme, scopes] of inner) {
    const held = outer.get(scheme);
    if (!held) return false;
    for (const scope of scopes) if (!held.has(scope)) return false;
  }
  return true;
}

function describeRequirement(req: Requirement): string {
  if (req.size === 0) return NO_AUTH;
  return [...req]
    .map(([scheme, scopes]) => (scopes.size ? `${scheme} [${[...scopes].join(', ')}]` : scheme))
    .join(' + ');
}

function diffSecurity(a: OperationSide, b: OperationSide, endpoint: string, ctx: Context): void {
  const oldReqs = effectiveSecurity(a);
  const newReqs = effectiveSecurity(b);

  // A client that authenticated one of the old ways must still be accepted.
  const stranded = oldReqs.filter((old) => !newReqs.some((n) => isSatisfiedBy(n, old)));
  if (stranded.length) {
    ctx.emit({
      kind: 'security.tightened',
      endpoint,
      location: 'security',
      before: oldReqs.map(describeRequirement),
      after: newReqs.map(describeRequirement),
      detail: { stranded: stranded.map(describeRequirement) },
    });
  }

  // Anything the new contract accepts that the old one didn't is a relaxation.
  const relaxed = newReqs.filter((n) => !oldReqs.some((old) => isSatisfiedBy(old, n)));
  if (relaxed.length) {
    ctx.emit({
      kind: 'security.loosened',
      endpoint,
      location: 'security',
      before: oldReqs.map(describeRequirement),
      after: newReqs.map(describeRequirement),
      detail: { relaxed: relaxed.map(describeRequirement) },
    });
  }
}

// ------------------------------------------------------------------- helpers

function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
}

function label(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
