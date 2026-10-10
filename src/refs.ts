import type { OpenAPIObject } from './types.js';

export class RefError extends Error {}

/** Resolves local JSON-pointer `$ref`s ("#/components/schemas/Order") within one document. */
export class RefResolver {
  constructor(private readonly doc: OpenAPIObject) {}

  /**
   * Follows a chain of `$ref`s until it reaches a concrete node.
   * `ref` is the first reference followed, used by callers for cycle detection.
   */
  resolve(node: unknown): { node: OpenAPIObject | undefined; ref?: string } {
    let current = node;
    let ref: string | undefined;
    const seen = new Set<string>();

    while (isRef(current)) {
      const pointer = current.$ref;
      if (seen.has(pointer)) throw new RefError(`Circular $ref alias: ${pointer}`);
      seen.add(pointer);
      ref ??= pointer;
      current = this.lookup(pointer);
    }

    return { node: isObject(current) ? current : undefined, ref };
  }

  lookup(pointer: string): unknown {
    if (!pointer.startsWith('#')) {
      throw new RefError(`External $ref is not supported yet: ${pointer} (bundle the spec first)`);
    }
    const segments = pointer
      .slice(1)
      .split('/')
      .slice(1)
      .map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));

    let current: unknown = this.doc;
    for (const segment of segments) {
      if (!isObject(current) || !(segment in current)) {
        throw new RefError(`Unresolvable $ref: ${pointer}`);
      }
      current = current[segment];
    }
    return current;
  }
}

export function isObject(value: unknown): value is OpenAPIObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is { $ref: string } {
  return isObject(value) && typeof value.$ref === 'string';
}

/** Walks the whole document and checks that every `$ref` resolves. */
export function validateRefs(doc: OpenAPIObject): void {
  const resolver = new RefResolver(doc);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    if (typeof node.$ref === 'string') resolver.lookup(node.$ref);
    for (const value of Object.values(node)) visit(value);
  };
  visit(doc);
}
