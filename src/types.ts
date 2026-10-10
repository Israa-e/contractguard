/**
 * Loose OpenAPI typings. ContractGuard reads specs defensively, so these are
 * intentionally permissive: anything may be missing or malformed.
 */
export type OpenAPIObject = Record<string, any>;
export type SchemaObject = OpenAPIObject;

/**
 * Which way data flows across the contract. The same schema change can be
 * safe in one direction and breaking in the other: removing a field from a
 * request is usually fine, removing it from a response is not.
 */
export type Direction = 'request' | 'response';

/**
 * - breaking: existing consumers will fail under the declared rules.
 * - review:   may break some consumers; ContractGuard can't prove it's safe.
 * - safe:     backwards compatible for consumers that follow the contract.
 */
export type Severity = 'breaking' | 'review' | 'safe';

export const SEVERITIES: readonly Severity[] = ['breaking', 'review', 'safe'];

export type ChangeKind =
  // endpoints
  | 'endpoint.removed'
  | 'endpoint.added'
  | 'endpoint.deprecated'
  | 'operation.id.changed'
  // parameters
  | 'parameter.added'
  | 'parameter.removed'
  | 'parameter.required.added'
  | 'parameter.required.removed'
  // request body
  | 'request.body.added'
  | 'request.body.removed'
  | 'request.body.required.added'
  | 'request.body.required.removed'
  | 'request.mediaType.added'
  | 'request.mediaType.removed'
  // responses
  | 'response.status.added'
  | 'response.status.removed'
  | 'response.mediaType.added'
  | 'response.mediaType.removed'
  // security
  | 'security.tightened'
  | 'security.loosened'
  // schemas
  | 'schema.type.changed'
  | 'schema.type.widened'
  | 'schema.type.narrowed'
  | 'schema.nullable.added'
  | 'schema.nullable.removed'
  | 'schema.property.added'
  | 'schema.property.removed'
  | 'schema.required.added'
  | 'schema.required.removed'
  | 'schema.enum.widened'
  | 'schema.enum.narrowed'
  | 'schema.constraint.tightened'
  | 'schema.constraint.loosened'
  | 'schema.constraint.changed'
  | 'schema.composition.changed';

/** A structural difference found by the diff engine, before classification. */
export interface RawChange {
  kind: ChangeKind;
  /** e.g. "GET /orders/{id}" */
  endpoint: string;
  /** Human-readable position, e.g. "response 200 (application/json) → items[].total" */
  location: string;
  direction?: Direction;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
}

/** A RawChange with a compatibility verdict and an explanation. */
export interface Change extends RawChange {
  severity: Severity;
  message: string;
  reason: string;
  suggestion?: string;
}

export interface Report {
  changes: Change[];
  summary: Record<Severity, number>;
}
