import { LosslessNumber, parse } from 'lossless-json';
import { fail, MAX_FILE_BYTES, type ObjectValue } from './types';

function isParserNumber(value: unknown): value is LosslessNumber {
  return (
    value instanceof LosslessNumber && Object.getPrototypeOf(value) === LosslessNumber.prototype
  );
}
export function parseOtlp(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES)
    fail('FILE_TOO_LARGE', 'The file exceeds the 5 MiB limit. Export a smaller complete interval.');
  return ownValues(
    parse(text, undefined, {
      onDuplicateKey: ({ key }) => fail('DUPLICATE_JSON_KEY', `Repeated JSON object key: ${key}.`),
    }),
  );
}
// The parser assigns __proto__ using ordinary property assignment. Rebuild only
// own entries so unknown JSON fields cannot supply inherited OTLP metadata.
function ownValues(value: unknown): unknown {
  if (isParserNumber(value)) return value;
  if (Array.isArray(value)) return value.map(ownValues);
  if (value && typeof value === 'object') {
    const result: ObjectValue = Object.create(null);
    for (const [key, entry] of Object.entries(value)) result[key] = ownValues(entry);
    return result;
  }
  return value;
}
export function object(value: unknown, path: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isParserNumber(value))
    fail('INVALID_STRUCTURE', 'Expected an OTLP JSON object.', path);
  return value as ObjectValue;
}
export function array(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('INVALID_STRUCTURE', 'Expected an OTLP JSON array.', path);
  return value;
}
export function string(value: unknown, path: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('INVALID_STRUCTURE', 'Expected a string.', path);
  return value;
}
// Conservative OTLP subset: decimal integer tokens only. No rounding or coercion.
export function integer(value: unknown, path: string, unsigned = false, bits = 64): bigint {
  const token =
    typeof value === 'string'
      ? value
      : isParserNumber(value)
        ? value.value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? String(value)
          : '';
  if (!/^-?\d+$/.test(token) || token.length > 21)
    fail(
      'INVALID_INTEGER',
      'Expected an exact decimal integer (number or string). Fractional and exponent forms are not supported.',
      path,
    );
  const n = BigInt(token);
  const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
  const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
  if (n < min || n > max)
    fail(
      'INTEGER_OUT_OF_RANGE',
      `Integer is outside the ${unsigned ? 'unsigned' : 'signed'} ${bits}-bit OTLP range.`,
      path,
    );
  return n;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as ObjectValue)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
// Convert genuine parser number instances before structured cloning to the UI.
// Never trust user objects that imitate the parser's duck-typed number marker.
export function materializeNumbers(value: unknown, key = ''): unknown {
  if (isParserNumber(value)) return key === 'doubleValue' ? Number(value.value) : value.value;
  if (Array.isArray(value)) return value.map((v) => materializeNumbers(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materializeNumbers(v, k)]));
  return value;
}
export function attributes(value: unknown, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [i, entry] of array(value, path).entries()) {
    const attr = object(entry, `${path}[${i}]`);
    const key = string(attr.key, `${path}[${i}].key`);
    if (!key) fail('INVALID_ATTRIBUTE', 'Attribute keys must be nonempty.', path);
    if (Object.hasOwn(result, key))
      fail('DUPLICATE_ATTRIBUTE', `Duplicate attribute key: ${key}.`, path);
    result[key] = anyValue(attr.value, `${path}[${i}].value`);
  }
  return result;
}
function anyValue(value: unknown, path: string): unknown {
  const v = object(value, path);
  const types = [
    'stringValue',
    'boolValue',
    'intValue',
    'doubleValue',
    'arrayValue',
    'kvlistValue',
    'bytesValue',
  ].filter((k) => v[k] !== undefined && v[k] !== null);
  if (types.length !== 1)
    fail('INVALID_ATTRIBUTE', 'An attribute must have exactly one recognized AnyValue type.', path);
  const type = types[0],
    raw = v[type];
  if (type === 'boolValue') {
    if (typeof raw !== 'boolean')
      fail('INVALID_ATTRIBUTE', 'boolValue must be a JSON boolean.', path);
    return raw;
  }
  if (type === 'stringValue') return { stringValue: string(raw, path) };
  if (type === 'bytesValue') {
    const encoded = string(raw, path);
    if (!/^(?:[A-Za-z0-9+/]*|[A-Za-z0-9_-]*)={0,2}$/.test(encoded))
      fail('INVALID_ATTRIBUTE', 'bytesValue must be valid standard or URL-safe base64.', path);
    try {
      return { bytesValue: btoa(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) };
    } catch {
      fail('INVALID_ATTRIBUTE', 'bytesValue must be valid standard or URL-safe base64.', path);
    }
  }
  if (type === 'intValue') return { intValue: integer(raw, path).toString() };
  if (type === 'doubleValue') {
    const n = isParserNumber(raw)
      ? Number(raw.value)
      : typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(n))
      fail(
        'INVALID_ATTRIBUTE',
        'Nonfinite or malformed attribute doubles are not supported.',
        path,
      );
    return { doubleValue: n };
  }
  const nested = object(raw, path);
  return type === 'arrayValue'
    ? { arrayValue: array(nested.values, path).map((v) => anyValue(v, path)) }
    : { kvlistValue: attributes(nested.values, path) };
}
