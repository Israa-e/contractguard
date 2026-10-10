import { compare } from '../src/index.js';
import type { Change, OpenAPIObject, SchemaObject } from '../src/types.js';

export function spec(paths: OpenAPIObject, extra: OpenAPIObject = {}): OpenAPIObject {
  return { openapi: '3.0.3', info: { title: 't', version: '1' }, paths, ...extra };
}

/** A single POST /things whose request body and 200 response use the given schemas. */
export function endpointSpec(
  { request, response }: { request?: SchemaObject; response?: SchemaObject },
  components: OpenAPIObject = {},
): OpenAPIObject {
  const op: OpenAPIObject = { responses: { '200': { description: 'ok' } } };
  if (request) op.requestBody = { required: true, content: { 'application/json': { schema: request } } };
  if (response) op.responses['200'].content = { 'application/json': { schema: response } };
  return spec({ '/things': { post: op } }, { components: { schemas: components } });
}

export function changes(oldDoc: OpenAPIObject, newDoc: OpenAPIObject): Change[] {
  return compare(oldDoc, newDoc).changes;
}

/** Compact "severity kind" pairs, the shape most assertions care about. */
export function verdicts(oldDoc: OpenAPIObject, newDoc: OpenAPIObject): string[] {
  return changes(oldDoc, newDoc).map((c) => `${c.severity} ${c.kind}`);
}

export const obj = (properties: Record<string, SchemaObject>, required: string[] = []): SchemaObject => ({
  type: 'object',
  properties,
  required,
});
