export type Diagnostic = {
  status: 'INVALID_INPUT' | 'UNSUPPORTED_INPUT';
  code: string;
  message: string;
  path?: string;
};
export class InputError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export function fail(
  code: string,
  message: string,
  path?: string,
  status: Diagnostic['status'] = 'INVALID_INPUT',
): never {
  throw new InputError({ status, code, message, path });
}
export function diagnostic(error: unknown): Diagnostic {
  return error instanceof InputError
    ? error.diagnostic
    : {
        status: 'INVALID_INPUT',
        code: 'INVALID_JSON',
        message: 'The file is not valid, unambiguous JSON. Check syntax and duplicate object keys.',
      };
}
export type ObjectValue = Record<string, unknown>;
export type Attributes = Record<string, unknown>;
export type Identity = {
  resource: Attributes;
  resourceSchemaUrl: string;
  scope: { name: string; version: string; attributes: Attributes };
  scopeSchemaUrl: string;
  name: string;
  type: string;
  unit: string;
  temporality: string;
  monotonic: boolean;
};
export type Interval = { id: string; start: string; end: string; points: ObjectValue[] };
export type Snapshot = { id: string; end: string; points: ObjectValue[] };
export type Stream = {
  id: string;
  identity: Identity;
  intervals: Interval[];
  snapshots: Snapshot[];
  diagnostics: Diagnostic[];
};
export type ImportData = { streams: Stream[]; diagnostics: Diagnostic[] };
export type Rational = { numerator: bigint; denominator: bigint };
export type Verdict = 'WITHIN_LIMIT' | 'EXCEEDS_LIMIT' | 'INDETERMINATE' | 'NO_DATA';
export type Counts = { K: bigint; E: bigint; O: bigint; T: bigint };
export type Calculation = Counts & {
  status: Verdict;
  lower: Rational | null;
  upper: Rational | null;
  threshold: Rational;
};
export type Analysis =
  | { status: 'INVALID_INPUT' | 'UNSUPPORTED_INPUT'; diagnostic: Diagnostic }
  | (Calculation & { points: { attributes: Attributes; count: string; overflow: boolean }[] });
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PAIR_BYTES = 2 * MAX_FILE_BYTES;
export const OVERFLOW = 'otel.metric.overflow';
export const CONTRACT =
  'This is a complete export of the selected interval from a synchronous SDK request counter, before transformations that change values or measurement attributes. The counter counts requests, and every request has a boolean outcome.';
export const CUMULATIVE_CONTRACT =
  'Both snapshots are complete SDK exports of the selected synchronous request counter from one continuous source history, with no resets or changes to counts or attribution by downstream transformations. Every request has one boolean outcome. The selected overflow marker has genuine SDK overflow semantics, with stable ordinary attribution across collections.';
