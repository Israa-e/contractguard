import { describe, expect, it } from 'vitest';
import type { SchemaObject } from '../src/types.js';
import { changes, endpointSpec, obj, verdicts } from './helpers.js';

/**
 * Each scenario is checked in both directions, because the same schema edit
 * has opposite consequences for requests and responses.
 */
interface Scenario {
  name: string;
  before: SchemaObject;
  after: SchemaObject;
  request: string[];
  response: string[];
}

const scenarios: Scenario[] = [
  {
    name: 'property removed',
    before: obj({ id: { type: 'integer' }, total: { type: 'number' } }, ['id', 'total']),
    after: obj({ id: { type: 'integer' } }, ['id']),
    request: ['review schema.property.removed'],
    response: ['breaking schema.property.removed'],
  },
  {
    name: 'optional property added',
    before: obj({ id: { type: 'integer' } }),
    after: obj({ id: { type: 'integer' }, note: { type: 'string' } }),
    request: ['safe schema.property.added'],
    response: ['safe schema.property.added'],
  },
  {
    name: 'required property added',
    before: obj({ id: { type: 'integer' } }),
    after: obj({ id: { type: 'integer' }, address: { type: 'string' } }, ['address']),
    request: ['breaking schema.property.added'],
    response: ['safe schema.property.added'],
  },
  {
    name: 'property becomes required',
    before: obj({ a: { type: 'string' } }),
    after: obj({ a: { type: 'string' } }, ['a']),
    request: ['breaking schema.required.added'],
    response: ['safe schema.required.added'],
  },
  {
    name: 'property becomes optional',
    before: obj({ a: { type: 'string' } }, ['a']),
    after: obj({ a: { type: 'string' } }),
    request: ['safe schema.required.removed'],
    response: ['breaking schema.required.removed'],
  },
  {
    name: 'number → string',
    before: obj({ total: { type: 'number' } }),
    after: obj({ total: { type: 'string' } }),
    request: ['breaking schema.type.changed'],
    response: ['breaking schema.type.changed'],
  },
  {
    name: 'integer → number (widening)',
    before: obj({ qty: { type: 'integer' } }),
    after: obj({ qty: { type: 'number' } }),
    request: ['safe schema.type.widened'],
    response: ['breaking schema.type.widened'],
  },
  {
    name: 'number → integer (narrowing)',
    before: obj({ qty: { type: 'number' } }),
    after: obj({ qty: { type: 'integer' } }),
    request: ['breaking schema.type.narrowed'],
    response: ['safe schema.type.narrowed'],
  },
  {
    name: 'nullable added (3.0 style)',
    before: obj({ note: { type: 'string' } }),
    after: obj({ note: { type: 'string', nullable: true } }),
    request: ['safe schema.nullable.added'],
    response: ['breaking schema.nullable.added'],
  },
  {
    name: 'nullable removed (3.1 style)',
    before: obj({ note: { type: ['string', 'null'] } }),
    after: obj({ note: { type: 'string' } }),
    request: ['breaking schema.nullable.removed'],
    response: ['safe schema.nullable.removed'],
  },
  {
    name: 'enum value added',
    before: { type: 'string', enum: ['a', 'b'] },
    after: { type: 'string', enum: ['a', 'b', 'c'] },
    request: ['safe schema.enum.widened'],
    response: ['review schema.enum.widened'],
  },
  {
    name: 'enum value removed',
    before: { type: 'string', enum: ['a', 'b'] },
    after: { type: 'string', enum: ['a'] },
    request: ['breaking schema.enum.narrowed'],
    response: ['safe schema.enum.narrowed'],
  },
  {
    name: 'maxLength decreased',
    before: { type: 'string', maxLength: 500 },
    after: { type: 'string', maxLength: 100 },
    request: ['breaking schema.constraint.tightened'],
    response: ['safe schema.constraint.tightened'],
  },
  {
    name: 'minimum lowered',
    before: { type: 'integer', minimum: 1 },
    after: { type: 'integer', minimum: 0 },
    request: ['safe schema.constraint.loosened'],
    response: ['review schema.constraint.loosened'],
  },
  {
    name: 'pattern changed',
    before: { type: 'string', pattern: '^[0-9]+$' },
    after: { type: 'string', pattern: '^[a-z]+$' },
    request: ['review schema.constraint.changed'],
    response: ['review schema.constraint.changed'],
  },
  {
    name: 'additionalProperties forbidden',
    before: obj({ a: { type: 'string' } }),
    after: { ...obj({ a: { type: 'string' } }), additionalProperties: false },
    request: ['breaking schema.constraint.tightened'],
    response: ['safe schema.constraint.tightened'],
  },
  {
    name: 'oneOf variant added',
    before: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    after: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] },
    request: ['review schema.composition.changed'],
    response: ['review schema.composition.changed'],
  },
  {
    name: 'array item property removed',
    before: { type: 'array', items: obj({ id: { type: 'integer' }, sku: { type: 'string' } }) },
    after: { type: 'array', items: obj({ id: { type: 'integer' } }) },
    request: ['review schema.property.removed'],
    response: ['breaking schema.property.removed'],
  },
  {
    name: 'identical schemas',
    before: obj({ id: { type: 'integer' } }, ['id']),
    after: obj({ id: { type: 'integer' } }, ['id']),
    request: [],
    response: [],
  },
];

describe('schema compatibility rules', () => {
  for (const s of scenarios) {
    it(`${s.name} (request)`, () => {
      expect(verdicts(endpointSpec({ request: s.before }), endpointSpec({ request: s.after }))).toEqual(s.request);
    });
    it(`${s.name} (response)`, () => {
      expect(verdicts(endpointSpec({ response: s.before }), endpointSpec({ response: s.after }))).toEqual(s.response);
    });
  }
});

describe('schema diff details', () => {
  it('reports the full path to nested changes', () => {
    const before = obj({ items: { type: 'array', items: obj({ total: { type: 'number' } }) } });
    const after = obj({ items: { type: 'array', items: obj({}) } });
    const [change] = changes(endpointSpec({ response: before }), endpointSpec({ response: after }));
    expect(change.location).toBe('response 200 (application/json) → items[].total');
  });

  it('detects a likely rename and suggests a migration path', () => {
    const before = obj({ total: { type: 'number' } }, ['total']);
    const after = obj({ amount: { type: 'number' } }, ['amount']);
    const removed = changes(endpointSpec({ response: before }), endpointSpec({ response: after })).find(
      (c) => c.kind === 'schema.property.removed',
    )!;
    expect(removed.message).toContain('looks renamed to `amount`');
    expect(removed.suggestion).toContain('Return both `total` and `amount`');
  });

  it('does not guess a rename when it is ambiguous', () => {
    const before = obj({ total: { type: 'number' } });
    const after = obj({ amount: { type: 'number' }, price: { type: 'number' } });
    const removed = changes(endpointSpec({ response: before }), endpointSpec({ response: after })).find(
      (c) => c.kind === 'schema.property.removed',
    )!;
    expect(removed.detail?.renamedTo).toBeUndefined();
  });

  it('follows $refs into components', () => {
    const v1 = endpointSpec({ response: { $ref: '#/components/schemas/Order' } }, {
      Order: obj({ total: { type: 'number' } }),
    });
    const v2 = endpointSpec({ response: { $ref: '#/components/schemas/Order' } }, {
      Order: obj({ total: { type: 'string' } }),
    });
    expect(verdicts(v1, v2)).toEqual(['breaking schema.type.changed']);
  });

  it('terminates on recursive schemas and still finds nested changes', () => {
    const category = (extra: SchemaObject = {}) => ({
      Category: obj({
        name: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/components/schemas/Category' } },
        ...extra,
      }),
    });
    const ref = { $ref: '#/components/schemas/Category' };
    const v1 = endpointSpec({ response: ref }, category({ slug: { type: 'string' } }));
    const v2 = endpointSpec({ response: ref }, category());
    expect(verdicts(v1, v2)).toEqual(['breaking schema.property.removed']);
  });

  it('merges allOf before comparing', () => {
    const base = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] };
    const v1 = endpointSpec({ response: { allOf: [base, obj({ total: { type: 'number' } }, ['total'])] } });
    const v2 = endpointSpec({ response: { allOf: [base, obj({ total: { type: 'number' } })] } });
    expect(verdicts(v1, v2)).toEqual(['breaking schema.required.removed']);
  });

  it('ignores readOnly properties in requests and writeOnly properties in responses', () => {
    const before = obj({ id: { type: 'integer', readOnly: true }, password: { type: 'string', writeOnly: true } });
    const after = obj({});
    expect(verdicts(endpointSpec({ request: before }), endpointSpec({ request: after }))).toEqual([
      'review schema.property.removed', // password
    ]);
    expect(verdicts(endpointSpec({ response: before }), endpointSpec({ response: after }))).toEqual([
      'breaking schema.property.removed', // id
    ]);
  });

  it('treats a removed request property as breaking when additional properties are forbidden', () => {
    const before = { ...obj({ a: { type: 'string' }, b: { type: 'string' } }), additionalProperties: false };
    const after = { ...obj({ a: { type: 'string' } }), additionalProperties: false };
    expect(verdicts(endpointSpec({ request: before }), endpointSpec({ request: after }))).toEqual([
      'breaking schema.property.removed',
    ]);
  });
});
