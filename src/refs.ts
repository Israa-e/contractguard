import type { OpenAPIObject } from './types.js';

export class RefError extends Error {}

/** Resolves local JSON-pointer `$ref`s ("#/components/schemas/Order") within one document. */
export class RefResolver {
  /** OpenAPI 3.1 schemas are JSON Schema 2020-12, where keywords next to `$ref` also apply. */
  private readonly schemaRefSiblingsApply: boolean;

  constructor(private readonly doc: OpenAPIObject) {
    this.schemaRefSiblingsApply = typeof doc.openapi === 'string' && doc.openapi.startsWith('3.1.');
  }

  /**
   * Like `resolve`, for Schema Objects. In OpenAPI 3.1 a `$ref` with sibling keywords
   * means "the target AND the siblings", so it resolves to `{ allOf: [target, siblings] }`.
   * In 3.0 a Reference Object's siblings are ignored, exactly as `resolve` does.
   */
  resolveSchema(
    node: unknown,
    seen: ReadonlySet<string> = new Set(),
  ): { node: OpenAPIObject | undefined; ref?: string } {
    if (!this.schemaRefSiblingsApply || !isRef(node)) return this.resolve(node);

    const { $ref: pointer, ...siblings } = node;
    if (seen.has(pointer)) throw new RefError(`Circular $ref alias: ${pointer}`);
    const target = this.resolveSchema(this.lookup(pointer), new Set(seen).add(pointer)).node;
    if (Object.keys(siblings).length === 0) return { node: target, ref: pointer };
    return { node: { allOf: [target ?? {}, siblings] }, ref: pointer };
  }

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

/** Walks the whole document and checks that every `$ref` chain resolves without looping. */
export function validateRefs(doc: OpenAPIObject): void {
  const resolver = new RefResolver(doc);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    if (typeof node.$ref === 'string') resolver.resolve(node);
    for (const value of Object.values(node)) visit(value);
  };
  visit(doc);
}
