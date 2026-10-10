import { METHODS } from './diff/spec.js';
import { RefResolver, isObject } from './refs.js';
import type { OpenAPIObject } from './types.js';

class Problem extends Error {}

/**
 * Checks the parts of a document that the comparison reads. The diff treats anything it
 * can't read as absent, so a malformed operation would otherwise be reported as "removed",
 * and a malformed `security` as "no authentication", instead of as an invalid spec.
 * Returns the first problem found. Expects `$ref`s to have been validated already.
 */
export function findStructureError(doc: OpenAPIObject): string | undefined {
  const refs = new RefResolver(doc);
  try {
    checkSecurity(doc.security, 'security');
    for (const [path, rawItem] of entries(doc.paths as OpenAPIObject)) {
      const at = `paths[${JSON.stringify(path)}]`;
      const item = object(refs, rawItem, at);
      checkParameters(refs, item.parameters, `${at}.parameters`);
      for (const method of METHODS) {
        const where = `${at}.${method}`;
        if (item[method] !== undefined) checkOperation(refs, object(refs, item[method], where), where);
      }
    }
  } catch (err) {
    if (err instanceof Problem) return err.message;
    throw err;
  }
  return undefined;
}

function checkOperation(refs: RefResolver, op: OpenAPIObject, at: string): void {
  checkParameters(refs, op.parameters, `${at}.parameters`);
  checkSecurity(op.security, `${at}.security`);
  if (op.requestBody !== undefined) {
    checkContent(refs, object(refs, op.requestBody, `${at}.requestBody`).content, `${at}.requestBody.content`);
  }
  if (op.responses !== undefined) {
    const responses = object(refs, op.responses, `${at}.responses`);
    for (const [status, response] of entries(responses)) {
      const where = `${at}.responses[${JSON.stringify(status)}]`;
      checkContent(refs, object(refs, response, where).content, `${where}.content`);
    }
  }
}

function checkParameters(refs: RefResolver, parameters: unknown, at: string): void {
  if (parameters === undefined) return;
  if (!Array.isArray(parameters)) throw new Problem(`${at}: expected an array`);
  parameters.forEach((raw, i) => {
    const p = object(refs, raw, `${at}[${i}]`);
    if (typeof p.name !== 'string' || typeof p.in !== 'string') {
      throw new Problem(`${at}[${i}]: expected string "name" and "in"`);
    }
  });
}

function checkContent(refs: RefResolver, content: unknown, at: string): void {
  if (content === undefined) return;
  for (const [type, media] of Object.entries(object(refs, content, at))) {
    object(refs, media, `${at}[${JSON.stringify(type)}]`);
  }
}

function checkSecurity(security: unknown, at: string): void {
  if (security === undefined) return;
  if (!Array.isArray(security)) throw new Problem(`${at}: expected an array`);
  security.forEach((alternative, i) => {
    if (!isObject(alternative)) throw new Problem(`${at}[${i}]: expected an object`);
    for (const [scheme, scopes] of Object.entries(alternative)) {
      if (!Array.isArray(scopes)) throw new Problem(`${at}[${i}].${scheme}: expected an array of scopes`);
    }
  });
}

/** Entries of an object that allows `x-` specification extensions, which can hold anything. */
function entries(map: OpenAPIObject): [string, unknown][] {
  return Object.entries(map).filter(([key]) => !key.startsWith('x-'));
}

function object(refs: RefResolver, value: unknown, at: string): OpenAPIObject {
  const node = refs.resolve(value).node;
  if (!node) throw new Problem(`${at}: expected an object`);
  return node;
}
