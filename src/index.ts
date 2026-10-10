import { diffSpecs } from './diff/spec.js';
import { loadSpec, parseSpec } from './loader.js';
import { classify } from './rules.js';
import { SEVERITIES, type OpenAPIObject, type Report, type Severity } from './types.js';

export { loadSpec, parseSpec, SpecLoadError } from './loader.js';
export type * from './types.js';

/** Compares two already-parsed OpenAPI documents. */
export function compare(oldDoc: OpenAPIObject, newDoc: OpenAPIObject): Report {
  const seen = new Set<string>();
  const changes = diffSpecs(oldDoc, newDoc)
    .map(classify)
    .filter((c) => {
      const key = `${c.kind}|${c.endpoint}|${c.location}|${c.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (x, y) =>
        SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) ||
        x.endpoint.localeCompare(y.endpoint) ||
        x.location.localeCompare(y.location),
    );

  const summary = { breaking: 0, review: 0, safe: 0 } satisfies Record<Severity, number>;
  for (const c of changes) summary[c.severity]++;
  return { changes, summary };
}

/** Loads and compares two spec files (YAML or JSON). */
export async function compareFiles(oldFile: string, newFile: string): Promise<Report> {
  const [oldSpec, newSpec] = await Promise.all([loadSpec(oldFile), loadSpec(newFile)]);
  return compare(oldSpec.doc, newSpec.doc);
}

/** Convenience for tests and programmatic use with in-memory YAML/JSON strings. */
export function compareText(oldText: string, newText: string): Report {
  return compare(parseSpec(oldText, 'old').doc, parseSpec(newText, 'new').doc);
}
