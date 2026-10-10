import { NO_AUTH } from './diff/spec.js';
import type { Change, ChangeKind, RawChange, Severity } from './types.js';

interface Verdict {
  severity: Severity;
  message: string;
  reason: string;
  suggestion?: string;
}

type Rule = (change: RawChange) => Verdict;

const code = (value: unknown) => `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
const list = (values: unknown) => (Array.isArray(values) ? values.map(code).join(', ') : code(values));
const name = (c: RawChange) => code(c.detail?.name);
const isRequest = (c: RawChange) => c.direction === 'request';

/**
 * One rule per change kind. Rules are deterministic and every verdict carries its
 * reasoning, so a failed check always explains itself.
 *
 * Assumption throughout: clients follow the contract and ignore unknown response
 * fields (the "tolerant reader" pattern). Where that assumption is shaky, the
 * verdict is `review` rather than `safe`.
 */
const RULES: Record<ChangeKind, Rule> = {
  // ---------------------------------------------------------------- endpoints
  'endpoint.removed': (c) => ({
    severity: 'breaking',
    message: 'Endpoint removed',
    reason: c.detail?.deprecated
      ? 'The endpoint was deprecated, but removing it still breaks every client that has not migrated yet (they will get 404/405).'
      : 'Clients calling this endpoint will get 404 or 405 responses.',
    suggestion:
      'Mark it `deprecated: true` and keep it until consumers have migrated, or ship the removal as a new major API version.',
  }),
  'endpoint.added': () => ({
    severity: 'safe',
    message: 'Endpoint added',
    reason: 'Existing clients are unaffected by new endpoints.',
  }),
  'endpoint.deprecated': () => ({
    severity: 'safe',
    message: 'Endpoint marked as deprecated',
    reason: 'Deprecation is not breaking by itself. Track which consumers still call it before removing it.',
  }),
  'operation.id.changed': (c) => ({
    severity: 'review',
    message: `operationId changed from ${code(c.before)} to ${code(c.after)}`,
    reason:
      'The HTTP contract is unchanged, but generated SDKs use operationId for method names. Regenerating a client will rename its methods and break code that calls them.',
    suggestion: 'Keep operationIds stable unless you are intentionally releasing a new SDK major version.',
  }),

  // --------------------------------------------------------------- parameters
  'parameter.added': (c) =>
    c.detail?.required
      ? {
          severity: 'breaking',
          message: `New required parameter ${name(c)}`,
          reason: 'Existing clients do not send this parameter, so their requests will be rejected.',
          suggestion: 'Make the parameter optional and apply a server-side default when it is missing.',
        }
      : {
          severity: 'safe',
          message: `New optional parameter ${name(c)}`,
          reason: 'Existing clients can keep omitting it.',
        },
  'parameter.removed': (c) => ({
    severity: 'review',
    message: `Parameter ${name(c)} removed`,
    reason:
      'Clients that still send it will have it ignored, or rejected if the server validates strictly. Any behaviour it controlled is gone for them.',
    suggestion: 'Keep accepting the parameter (marked deprecated) for a transition period.',
  }),
  'parameter.required.added': (c) => ({
    severity: 'breaking',
    message: `Parameter ${name(c)} is now required`,
    reason: 'Clients that omitted the optional parameter will now have their requests rejected.',
    suggestion: 'Keep it optional and fall back to the previous default behaviour.',
  }),
  'parameter.required.removed': (c) => ({
    severity: 'safe',
    message: `Parameter ${name(c)} is now optional`,
    reason: 'Clients that send it keep working.',
  }),

  // ------------------------------------------------------------- request body
  'request.body.added': (c) =>
    c.detail?.required
      ? {
          severity: 'breaking',
          message: 'Required request body added',
          reason: 'Existing clients send no body and will be rejected.',
          suggestion: 'Make the body optional, or add it on a new endpoint/version.',
        }
      : {
          severity: 'safe',
          message: 'Optional request body added',
          reason: 'Existing clients can keep sending no body.',
        },
  'request.body.removed': () => ({
    severity: 'review',
    message: 'Request body removed',
    reason: 'Clients still sending a body may have it ignored or rejected, and lose whatever it controlled.',
  }),
  'request.body.required.added': () => ({
    severity: 'breaking',
    message: 'Request body is now required',
    reason: 'Clients that sent no body will now be rejected.',
    suggestion: 'Keep the body optional and handle its absence on the server.',
  }),
  'request.body.required.removed': () => ({
    severity: 'safe',
    message: 'Request body is now optional',
    reason: 'Clients that send a body keep working.',
  }),
  'request.mediaType.added': (c) => ({
    severity: 'safe',
    message: `Request content type ${code(c.detail?.mediaType)} added`,
    reason: 'Clients can keep using the content types they already send.',
  }),
  'request.mediaType.removed': (c) => ({
    severity: 'breaking',
    message: `Request content type ${code(c.detail?.mediaType)} no longer accepted`,
    reason: 'Clients sending this content type will get 415 Unsupported Media Type.',
    suggestion: 'Keep accepting the old content type alongside the new one.',
  }),

  // ---------------------------------------------------------------- responses
  'response.status.removed': (c) =>
    c.detail?.success
      ? {
          severity: 'breaking',
          message: `Success response ${code(c.detail.status)} removed`,
          reason: `Clients that check for HTTP ${c.detail.status} will treat the new response as a failure.`,
          suggestion: 'Keep returning the original status code, or version the endpoint.',
        }
      : {
          severity: 'review',
          message: `Documented response ${code(c.detail?.status)} removed`,
          reason:
            'Clients with explicit handling for this status will no longer see it. Confirm the condition is now reported some other way.',
        },
  'response.status.added': (c) =>
    c.detail?.success
      ? {
          severity: 'review',
          message: `New success response ${code(c.detail.status)}`,
          reason: `Clients that check for one specific success code may treat HTTP ${c.detail.status} as an error.`,
        }
      : {
          severity: 'safe',
          message: `New error response ${code(c.detail?.status)} documented`,
          reason: 'Clients are expected to handle unlisted error statuses generically.',
        },
  'response.mediaType.added': (c) => ({
    severity: 'safe',
    message: `Response content type ${code(c.detail?.mediaType)} added`,
    reason: 'Clients keep receiving the content types they negotiate for.',
  }),
  'response.mediaType.removed': (c) => ({
    severity: 'breaking',
    message: `Response content type ${code(c.detail?.mediaType)} removed`,
    reason: 'Clients that request or parse this content type will fail.',
    suggestion: 'Keep producing the old content type alongside the new one.',
  }),

  // ----------------------------------------------------------------- security
  'security.tightened': (c) => {
    const stranded = (c.detail?.stranded as string[] | undefined) ?? [];
    return stranded.includes(NO_AUTH)
      ? {
          severity: 'breaking',
          message: 'Endpoint now requires authentication',
          reason: `Anonymous clients will be rejected with 401. Now required: ${list(c.after)}.`,
          suggestion: 'Keep the endpoint public (`security: []`), or roll out authentication behind a new version.',
        }
      : {
          severity: 'breaking',
          message: 'Authentication requirements tightened',
          reason: `Clients authenticating with ${list(stranded)} will be rejected (401/403). Now required: ${list(c.after)}.`,
          suggestion: 'Accept both the old and new requirements during a migration window.',
        };
  },
  'security.loosened': (c) => ({
    severity: 'review',
    message: 'Authentication requirements relaxed',
    reason: `The endpoint now also accepts ${list(c.detail?.relaxed)}. This does not break clients, but it may expose data. Confirm it is intentional.`,
  }),

  // ------------------------------------------------------------------ schemas
  'schema.type.changed': (c) => ({
    severity: 'breaking',
    message: `Type changed from ${code(c.before)} to ${code(c.after)}`,
    reason: isRequest(c)
      ? 'Clients sending the old type will fail validation.'
      : 'Clients deserializing the old type will fail or misread the value.',
    suggestion: 'Add a new field with the new type and deprecate the old one instead of changing it in place.',
  }),
  'schema.type.widened': (c) =>
    isRequest(c)
      ? {
          severity: 'safe',
          message: `Accepted type widened from ${code(c.before)} to ${code(c.after)}`,
          reason: 'Everything clients sent before is still accepted.',
        }
      : {
          severity: 'breaking',
          message: `Response type widened from ${code(c.before)} to ${code(c.after)}`,
          reason: 'Clients may now receive values of a type they cannot parse.',
          suggestion: 'Keep the response type stable, or expose the wider type in a new field.',
        },
  'schema.type.narrowed': (c) =>
    isRequest(c)
      ? {
          severity: 'breaking',
          message: `Accepted type narrowed from ${code(c.before)} to ${code(c.after)}`,
          reason: 'Clients sending values of the dropped type will be rejected.',
          suggestion: 'Keep accepting the old type(s) and convert on the server.',
        }
      : {
          severity: 'safe',
          message: `Response type narrowed from ${code(c.before)} to ${code(c.after)}`,
          reason: 'Clients only receive values they already handle.',
        },
  'schema.nullable.added': (c) =>
    isRequest(c)
      ? { severity: 'safe', message: 'Now accepts null', reason: 'Clients sending non-null values keep working.' }
      : {
          severity: 'breaking',
          message: 'Response value can now be null',
          reason: 'Clients that assume a value is always present may crash on null.',
          suggestion: 'Keep the field non-null, or omit it instead and document the fallback.',
        },
  'schema.nullable.removed': (c) =>
    isRequest(c)
      ? {
          severity: 'breaking',
          message: 'No longer accepts null',
          reason: 'Clients sending null will be rejected.',
          suggestion: 'Keep accepting null and map it to a default on the server.',
        }
      : { severity: 'safe', message: 'Response value is no longer null', reason: 'Clients already handle non-null values.' },
  'schema.property.removed': (c) => {
    const renamedTo = c.detail?.renamedTo;
    if (!isRequest(c)) {
      return {
        severity: 'breaking',
        message: renamedTo
          ? `Response property ${name(c)} removed (looks renamed to ${code(renamedTo)})`
          : `Response property ${name(c)} removed`,
        reason: 'Clients that read this property will get undefined/null and may fail.',
        suggestion: renamedTo
          ? `Return both ${name(c)} and ${code(renamedTo)} during a transition period (mark ${name(c)} \`deprecated: true\`), then remove it once consumers have migrated.`
          : `Keep ${name(c)} during a transition period (mark it \`deprecated: true\`), or publish a new API version and migrate consumers.`,
      };
    }
    return c.detail?.additionalPropertiesForbidden
      ? {
          severity: 'breaking',
          message: `Request property ${name(c)} removed`,
          reason: 'The schema forbids additional properties, so clients still sending this property will be rejected.',
          suggestion: 'Keep accepting the property (and ignore it) for a transition period.',
        }
      : {
          severity: 'review',
          message: `Request property ${name(c)} removed`,
          reason: 'Clients still sending it will have it ignored. Any behaviour it controlled is silently lost.',
        };
  },
  'schema.property.added': (c) => {
    if (!isRequest(c)) {
      return {
        severity: 'safe',
        message: `Response property ${name(c)} added`,
        reason:
          'Clients that ignore unknown fields are unaffected. Strict deserializers that reject unknown fields would break.',
      };
    }
    return c.detail?.required
      ? {
          severity: 'breaking',
          message: `New required request property ${name(c)}`,
          reason: 'Existing clients do not send this property, so their requests will fail validation.',
          suggestion: 'Make it optional with a server-side default.',
        }
      : {
          severity: 'safe',
          message: `New optional request property ${name(c)}`,
          reason: 'Existing clients can keep omitting it.',
        };
  },
  'schema.required.added': (c) =>
    isRequest(c)
      ? {
          severity: 'breaking',
          message: `Request property ${name(c)} is now required`,
          reason: 'Clients that omitted it will now fail validation.',
          suggestion: 'Keep it optional with a server-side default.',
        }
      : {
          severity: 'safe',
          message: `Response property ${name(c)} is now always present`,
          reason: 'Clients that handled it being absent keep working.',
        },
  'schema.required.removed': (c) =>
    isRequest(c)
      ? {
          severity: 'safe',
          message: `Request property ${name(c)} is now optional`,
          reason: 'Clients that send it keep working.',
        }
      : {
          severity: 'breaking',
          message: `Response property ${name(c)} is no longer guaranteed`,
          reason: 'Clients that assume it is always present may fail when it is missing.',
          suggestion: 'Keep the property required in responses, or document a default the server always sends.',
        },
  'schema.enum.widened': (c) =>
    isRequest(c)
      ? {
          severity: 'safe',
          message: `New accepted value(s): ${list(c.detail?.values)}`,
          reason: 'Clients can keep sending the values they already use.',
        }
      : {
          severity: 'review',
          message: `New response enum value(s): ${list(c.detail?.values)}`,
          reason:
            'Clients with exhaustive enum handling (Swift, Kotlin and Dart enums, `switch` with no default) may crash on an unknown value.',
          suggestion: 'Confirm consumers have a fallback for unknown values before releasing.',
        },
  'schema.enum.narrowed': (c) =>
    isRequest(c)
      ? {
          severity: 'breaking',
          message: `Value(s) no longer accepted: ${list(c.detail?.values)}`,
          reason: 'Clients sending these values will be rejected.',
          suggestion: 'Keep accepting the old values and map them on the server.',
        }
      : {
          severity: 'safe',
          message: `Response enum value(s) no longer returned: ${list(c.detail?.values)}`,
          reason: 'Clients only receive values they already handle.',
        },
  'schema.constraint.tightened': (c) =>
    isRequest(c)
      ? {
          severity: 'breaking',
          message: `Validation tightened: ${code(c.detail?.constraint)} ${describeBounds(c)}`,
          reason: 'Input that was valid before may now be rejected.',
          suggestion: 'Keep the old limit for existing clients, or validate the stricter rule only on new endpoints.',
        }
      : {
          severity: 'safe',
          message: `Response constraint tightened: ${code(c.detail?.constraint)} ${describeBounds(c)}`,
          reason: 'Responses are a subset of what clients already handle.',
        },
  'schema.constraint.loosened': (c) =>
    isRequest(c)
      ? {
          severity: 'safe',
          message: `Validation relaxed: ${code(c.detail?.constraint)} ${describeBounds(c)}`,
          reason: 'Everything valid before is still valid.',
        }
      : {
          severity: 'review',
          message: `Response constraint relaxed: ${code(c.detail?.constraint)} ${describeBounds(c)}`,
          reason:
            'Clients may receive values they did not expect, such as longer strings or larger numbers. That matters if they store or validate them.',
        },
  'schema.constraint.changed': (c) => ({
    severity: 'review',
    message: `Constraint ${code(c.detail?.constraint)} changed ${describeBounds(c)}`,
    reason: 'ContractGuard cannot determine whether the new rule accepts more or fewer values.',
  }),
  'schema.composition.changed': (c) => ({
    severity: 'review',
    message: `Schema composition (${code(c.detail?.keyword)}) changed`,
    reason:
      'Changes to oneOf/anyOf/not alternatives cannot be proven compatible by structural comparison. Check the variants manually.',
  }),
};

function describeBounds(c: RawChange): string {
  return `(${c.before === undefined ? 'none' : JSON.stringify(c.before)} → ${c.after === undefined ? 'none' : JSON.stringify(c.after)})`;
}

export function classify(change: RawChange): Change {
  return { ...change, ...RULES[change.kind](change) };
}
