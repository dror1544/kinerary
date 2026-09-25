// A tiny projection engine for serving config through an ALLOW-list.
//
// Why this exists (issue #172): sanitizeConfig() and publicAgent() used to
// deep-copy trip.config.json and delete the fields someone had thought to
// delete. Everything else — every field added later, by anyone — reached every
// signed-in family member verbatim. That is a deny-list, and CLAUDE.md's
// "Security-sensitive paths" section records what deny-lists here have cost.
//
// A schema here is data: a tree of nodes that says, for every path, what shape
// may be served. `project(value, node)` builds a NEW value by walking the tree;
// it never copies anything the tree does not name, and never mutates its input.
//
// Fail-safe, the same convention as needs-schema.js / agent-schema.js: anything
// unrecognized resolves to the most restrictive option — here, not served.
//   * a key the tree does not name                     → dropped
//   * a value of the wrong shape (an object where a
//     scalar belongs, a {he, en, extra} bilingual)     → dropped (or its extra key)
//   * a value outside a closed set (`oneOf`)           → dropped
//
// Nothing is dropped silently. Every omission is recorded in the report by
// path, in one of two lists, and the difference is the point:
//   * `withheld` — known, and kept back on purpose (a hotel PIN, an identity
//     link, an organizer-only need). Expected on real configs.
//   * `dropped`  — NOT on the list. On a config a producer wrote this means the
//     producer grew a field the list does not know, and the site has silently
//     lost it; the server logs it at boot and the golden tests fail on it.
// Paths name keys and indices only. A key name is authored text in the config,
// so a report is for the server log and for tests, never for a response body.

const OMIT = Symbol('omit');

const scalar = Object.freeze({ kind: 'scalar' });
const withheld = Object.freeze({ kind: 'withheld' });
const oneOf = (values) => Object.freeze({ kind: 'oneOf', values: Object.freeze([...values]) });
const object = (fields) => Object.freeze({ kind: 'object', fields: Object.freeze({ ...fields }) });
const list = (items) => Object.freeze({ kind: 'list', items });
// A data-keyed object: the keys are values (country names, phase ids), every
// value has the same shape.
const map = (values) => Object.freeze({ kind: 'map', values });
// One slot, several legitimate shapes, chosen by the JSON type actually found.
const byType = (branches) => Object.freeze({ kind: 'byType', ...branches });
// Escape hatch for rules that are not about shape (visibility filters,
// normalization). `fn(value, report, path)` returns the value to serve or OMIT.
const custom = (fn) => Object.freeze({ kind: 'custom', fn });

// Bilingual text as every renderer here reads it (_biSpan, bilingualSchema):
// a plain string, or {he, en}.
const text = byType({ scalar, object: object({ he: scalar, en: scalar }) });

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const join = (path, key) => (path ? `${path}.${key}` : String(key));

// A plain copy of an object's own enumerable properties, each read exactly
// once. Use it before a rule that both DECIDES on a property and SERVES it, so
// the two can never see different values.
function snapshot(value) {
  const out = {};
  for (const key of Object.keys(value)) put(out, key, value[key]);
  return out;
}

function newReport() {
  return { dropped: [], withheld: [] };
}

// defineProperty rather than assignment: a key is data, and assigning a key
// named "__proto__" would set the result's prototype instead of a property.
function put(out, key, value) {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function project(value, node, report = newReport(), path = '') {
  switch (node.kind) {
    case 'scalar':
      if (isScalar(value)) return value;
      report.dropped.push(path);
      return OMIT;
    case 'oneOf':
      if (isScalar(value) && node.values.includes(value)) return value;
      report.dropped.push(path);
      return OMIT;
    case 'withheld':
      report.withheld.push(path);
      return OMIT;
    case 'object': {
      if (!isPlainObject(value)) { report.dropped.push(path); return OMIT; }
      const out = {};
      for (const key of Object.keys(value)) {
        const child = join(path, key);
        if (!hasOwn(node.fields, key)) { report.dropped.push(child); continue; }
        const v = project(value[key], node.fields[key], report, child);
        if (v !== OMIT) put(out, key, v);
      }
      return out;
    }
    case 'map': {
      if (!isPlainObject(value)) { report.dropped.push(path); return OMIT; }
      const out = {};
      for (const key of Object.keys(value)) {
        const v = project(value[key], node.values, report, join(path, key));
        if (v !== OMIT) put(out, key, v);
      }
      return out;
    }
    case 'list': {
      if (!Array.isArray(value)) { report.dropped.push(path); return OMIT; }
      const out = [];
      value.forEach((item, i) => {
        const v = project(item, node.items, report, `${path}[${i}]`);
        if (v !== OMIT) out.push(v);
      });
      return out;
    }
    case 'byType': {
      const branch = Array.isArray(value) ? node.list
        : isPlainObject(value) ? node.object
        : isScalar(value) ? node.scalar
        : undefined;
      if (!branch) { report.dropped.push(path); return OMIT; }
      return project(value, branch, report, path);
    }
    case 'custom':
      return node.fn(value, report, path);
    default:
      // A malformed schema must not fail open either.
      report.dropped.push(path);
      return OMIT;
  }
}

module.exports = {
  OMIT, scalar, withheld, oneOf, object, list, map, byType, custom, text,
  newReport, project, snapshot,
};
