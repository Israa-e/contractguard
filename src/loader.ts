import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { RefError, isObject, validateRefs } from './refs.js';
import type { OpenAPIObject } from './types.js';
import { findStructureError } from './validate.js';

export class SpecLoadError extends Error {}

export interface LoadedSpec {
  source: string;
  version: string;
  doc: OpenAPIObject;
}

export async function loadSpec(file: string): Promise<LoadedSpec> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new SpecLoadError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  return parseSpec(text, file);
}

/** Parses and validates a YAML or JSON (YAML is a JSON superset) OpenAPI 3.x document. */
export function parseSpec(text: string, source = '<inline>'): LoadedSpec {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new SpecLoadError(`${source}: invalid YAML/JSON: ${(err as Error).message}`);
  }

  if (!isObject(doc)) {
    throw new SpecLoadError(`${source}: expected an OpenAPI document (an object at the top level)`);
  }
  if ('swagger' in doc) {
    throw new SpecLoadError(
      `${source}: Swagger 2.0 is not supported. Convert it to OpenAPI 3 first (e.g. with swagger2openapi).`,
    );
  }
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\.\d+/.test(doc.openapi)) {
    throw new SpecLoadError(`${source}: missing or unsupported "openapi" version (expected 3.0.x or 3.1.x)`);
  }
  if (doc.paths === undefined || doc.paths === null) {
    doc.paths = {};
  } else if (!isObject(doc.paths)) {
    throw new SpecLoadError(`${source}: "paths" must be an object`);
  }

  try {
    validateRefs(doc);
  } catch (err) {
    if (err instanceof RefError) throw new SpecLoadError(`${source}: ${err.message}`);
    throw err;
  }

  const problem = findStructureError(doc);
  if (problem) throw new SpecLoadError(`${source}: ${problem}`);

  return { source, version: doc.openapi, doc };
}
