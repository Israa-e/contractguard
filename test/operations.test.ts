import { describe, expect, it } from 'vitest';
import type { OpenAPIObject } from '../src/types.js';
import { changes, spec, verdicts } from './helpers.js';

const ok = { '200': { description: 'ok' } };

describe('endpoints', () => {
  it('flags a removed endpoint as breaking', () => {
    const v1 = spec({ '/a': { get: { responses: ok }, delete: { responses: ok } } });
    const v2 = spec({ '/a': { get: { responses: ok } } });
    expect(verdicts(v1, v2)).toEqual(['breaking endpoint.removed']);
  });

  it('flags a removed path as breaking for every operation', () => {
    const v1 = spec({ '/a': { get: { responses: ok }, post: { responses: ok } } });
    expect(verdicts(v1, spec({}))).toEqual(['breaking endpoint.removed', 'breaking endpoint.removed']);
  });

  it('treats added endpoints as safe', () => {
    expect(verdicts(spec({}), spec({ '/a': { get: { responses: ok } } }))).toEqual(['safe endpoint.added']);
  });

  it('does not report renamed path parameters', () => {
    const op = (name: string) => ({
      get: { parameters: [{ name, in: 'path', required: true, schema: { type: 'string' } }], responses: ok },
    });
    expect(verdicts(spec({ '/orders/{id}': op('id') }), spec({ '/orders/{orderId}': op('orderId') }))).toEqual([]);
  });

  it('reports deprecation and operationId changes', () => {
    const v1 = spec({ '/a': { get: { operationId: 'getA', responses: ok } } });
    const v2 = spec({ '/a': { get: { operationId: 'fetchA', deprecated: true, responses: ok } } });
    expect(verdicts(v1, v2).sort()).toEqual(['review operation.id.changed', 'safe endpoint.deprecated']);
  });
});

describe('parameters', () => {
  const withParams = (parameters: OpenAPIObject[], pathParameters: OpenAPIObject[] = []) =>
    spec({ '/a': { parameters: pathParameters, get: { parameters, responses: ok } } });
  const q = (name: string, extra: OpenAPIObject = {}) => ({ name, in: 'query', schema: { type: 'string' }, ...extra });

  it('new required parameter is breaking, optional is safe', () => {
    expect(verdicts(withParams([]), withParams([q('x', { required: true })]))).toEqual(['breaking parameter.added']);
    expect(verdicts(withParams([]), withParams([q('x')]))).toEqual(['safe parameter.added']);
  });

  it('parameter becoming required is breaking', () => {
    expect(verdicts(withParams([q('x')]), withParams([q('x', { required: true })]))).toEqual([
      'breaking parameter.required.added',
    ]);
  });

  it('removed parameter needs review', () => {
    expect(verdicts(withParams([q('x')]), withParams([]))).toEqual(['review parameter.removed']);
  });

  it('compares parameter schemas as request data', () => {
    const v1 = withParams([q('limit', { schema: { type: 'integer', maximum: 100 } })]);
    const v2 = withParams([q('limit', { schema: { type: 'integer', maximum: 10 } })]);
    const [change] = changes(v1, v2);
    expect(change.severity).toBe('breaking');
    expect(change.location).toBe('query parameter "limit"');
  });

  it('matches header parameters case-insensitively', () => {
    const h = (name: string) => ({ name, in: 'header', schema: { type: 'string' } });
    expect(verdicts(withParams([h('X-Trace-Id')]), withParams([h('x-trace-id')]))).toEqual([]);
  });

  it('lets operation parameters override path-level ones', () => {
    const v1 = withParams([q('x')], [q('x')]);
    const v2 = withParams([q('x')], [q('x', { required: true })]); // overridden: still optional
    expect(verdicts(v1, v2)).toEqual([]);
  });
});

describe('request bodies and responses', () => {
  const body = (requestBody?: OpenAPIObject, responses: OpenAPIObject = ok) =>
    spec({ '/a': { post: { ...(requestBody ? { requestBody } : {}), responses } } });
  const json = { 'application/json': { schema: { type: 'object' } } };

  it('required body added is breaking', () => {
    expect(verdicts(body(), body({ required: true, content: json }))).toEqual(['breaking request.body.added']);
  });

  it('body becoming required is breaking', () => {
    expect(verdicts(body({ content: json }), body({ required: true, content: json }))).toEqual([
      'breaking request.body.required.added',
    ]);
  });

  it('dropping a request content type is breaking', () => {
    const both = { ...json, 'application/xml': { schema: { type: 'object' } } };
    expect(verdicts(body({ content: both }), body({ content: json }))).toEqual(['breaking request.mediaType.removed']);
  });

  it('ignores media type parameters', () => {
    const charset = { 'application/json; charset=utf-8': json['application/json'] };
    expect(verdicts(body({ content: json }), body({ content: charset }))).toEqual([]);
  });

  it('removing a success status is breaking, adding one needs review', () => {
    const created = { '201': { description: 'created' } };
    expect(verdicts(body(undefined, ok), body(undefined, created)).sort()).toEqual([
      'breaking response.status.removed',
      'review response.status.added',
    ]);
  });

  it('documenting a new error status is safe', () => {
    expect(verdicts(body(undefined, ok), body(undefined, { ...ok, '429': { description: 'slow down' } }))).toEqual([
      'safe response.status.added',
    ]);
  });

  it('ignores x- extensions in the responses object', () => {
    const responses = (extension: OpenAPIObject) => ({ ...ok, ...extension });
    expect(verdicts(body(undefined, responses({ 'x-codegen': 'skip' })), body(undefined, ok))).toEqual([]);
    expect(verdicts(body(undefined, ok), body(undefined, responses({ 'x-codegen': 'skip' })))).toEqual([]);
  });

  it('removing a response content type is breaking', () => {
    const v1 = body(undefined, { '200': { description: 'ok', content: json } });
    expect(verdicts(v1, body(undefined, ok))).toEqual(['breaking response.mediaType.removed']);
  });

  it('resolves $ref responses and request bodies', () => {
    const components = (type: string) => ({
      components: {
        requestBodies: { In: { required: true, content: { 'application/json': { schema: { type } } } } },
        responses: { Out: { description: 'ok', content: { 'application/json': { schema: { type } } } } },
      },
    });
    const doc = (type: string) =>
      spec(
        {
          '/a': {
            post: {
              requestBody: { $ref: '#/components/requestBodies/In' },
              responses: { '200': { $ref: '#/components/responses/Out' } },
            },
          },
        },
        components(type),
      );
    expect(verdicts(doc('string'), doc('integer'))).toEqual([
      'breaking schema.type.changed',
      'breaking schema.type.changed',
    ]);
  });
});

describe('security', () => {
  const secured = (global: OpenAPIObject[] | undefined, op?: OpenAPIObject[]) =>
    spec({ '/a': { get: { ...(op ? { security: op } : {}), responses: ok } } }, global ? { security: global } : {});

  it('requiring auth on a public endpoint is breaking', () => {
    const [change] = changes(secured(undefined), secured([{ bearer: [] }]));
    expect(change.severity).toBe('breaking');
    expect(change.message).toBe('Endpoint now requires authentication');
  });

  it('removing auth needs review', () => {
    expect(verdicts(secured([{ bearer: [] }]), secured([{ bearer: [] }], []))).toEqual(['review security.loosened']);
  });

  it('requiring an extra scope is breaking, dropping one is a relaxation', () => {
    const read = secured([{ oauth: ['orders:read'] }]);
    const readWrite = secured([{ oauth: ['orders:read', 'orders:write'] }]);
    expect(verdicts(read, readWrite)).toEqual(['breaking security.tightened']);
    expect(verdicts(readWrite, read)).toEqual(['review security.loosened']);
  });

  it('adding an alternative scheme keeps old clients working', () => {
    const v1 = secured([{ bearer: [] }]);
    const v2 = secured([{ bearer: [] }, { apiKey: [] }]);
    expect(verdicts(v1, v2)).toEqual(['review security.loosened']);
  });

  it('replacing the scheme strands existing clients', () => {
    expect(verdicts(secured([{ bearer: [] }]), secured([{ apiKey: [] }]))).toEqual([
      'breaking security.tightened',
      'review security.loosened',
    ]);
  });
});
