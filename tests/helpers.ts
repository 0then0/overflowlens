import { analyze, type Settings } from '../src/core/analyze';
import { analyzeHttp, type HttpSettings } from '../src/core/http';
import { normalize } from '../src/core/normalize';
import { parseOtlp } from '../src/core/parse';
import type { Stream } from '../src/core/types';
export function fixture(
  success: string | number = '900',
  error: string | number = '1',
  overflow: string | number | null = '99',
) {
  const point = (attributes: unknown[], asInt: string | number) => ({
    attributes,
    asInt,
    startTimeUnixNano: '1000000000',
    timeUnixNano: '2000000000',
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
        scopeMetrics: [
          {
            scope: { name: 'test', version: '1' },
            metrics: [
              {
                name: 'requests',
                unit: '{request}',
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: 1,
                  dataPoints: [
                    point([{ key: 'success', value: { boolValue: true } }], success),
                    point([{ key: 'success', value: { boolValue: false } }], error),
                    ...(overflow === null
                      ? []
                      : [
                          point(
                            [{ key: 'otel.metric.overflow', value: { boolValue: true } }],
                            overflow,
                          ),
                        ]),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
export function importFixture(raw: unknown) {
  return normalize(parseOtlp(JSON.stringify(raw)));
}
export function run(stream: Stream, overrides: Partial<Settings> = {}) {
  return analyze(stream, {
    intervalId: stream.intervals[0]?.id ?? '',
    outcomeAttribute: 'success',
    errorValue: false,
    threshold: '1',
    contractConfirmed: true,
    ...overrides,
  });
}

// Synthetic complete snapshots near the import budget, with exactly 1% window errors.
export function largeCumulativeWindow(points = 28000) {
  const snapshot = (end: string, count: string) =>
    JSON.stringify({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'requests',
                  sum: {
                    isMonotonic: true,
                    aggregationTemporality: 2,
                    dataPoints: Array.from({ length: points }, (_, i) => ({
                      attributes: [
                        { key: 'success', value: { boolValue: i % 100 !== 0 } },
                        { key: 'id', value: { intValue: String(i) } },
                      ],
                      asInt: count,
                      startTimeUnixNano: '1000000000',
                      timeUnixNano: end,
                    })),
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  return { before: snapshot('2000000000', '100'), after: snapshot('3000000000', '101') };
}

export type HttpSpec = {
  status?: number | string | boolean | null;
  count?: string | number | null;
  overflow?: boolean;
  attributes?: unknown[];
  point?: Record<string, unknown>;
};
// Delta explicit-bucket http.server.request.duration histogram. Every ordinary
// point has a unique `test.id` so measurement identities never collide.
export function httpFixture(specs: HttpSpec[], metric: Record<string, unknown> = {}) {
  const points = specs.map((spec, i) => {
    const count = spec.count === undefined ? '1' : spec.count;
    const attributes: unknown[] = spec.overflow
      ? [{ key: 'otel.metric.overflow', value: { boolValue: true } }]
      : [{ key: 'test.id', value: { intValue: String(i) } }];
    if (!spec.overflow && spec.status !== null && spec.status !== undefined)
      attributes.push({
        key: 'http.response.status_code',
        value:
          typeof spec.status === 'string'
            ? { stringValue: spec.status }
            : typeof spec.status === 'boolean'
              ? { boolValue: spec.status }
              : { intValue: String(spec.status) },
      });
    attributes.push(...(spec.attributes ?? []));
    return {
      attributes,
      startTimeUnixNano: '1000000000',
      timeUnixNano: '2000000000',
      ...(count === null ? {} : { count }),
      sum: Number(count ?? 0) === 0 ? 0 : 0.5,
      bucketCounts: [String(count ?? 0), '0'],
      explicitBounds: [1],
      ...spec.point,
    };
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
        scopeMetrics: [
          {
            scope: { name: 'test', version: '1' },
            metrics: [
              {
                name: 'http.server.request.duration',
                unit: 's',
                histogram: { aggregationTemporality: 1, dataPoints: points },
                ...metric,
              },
            ],
          },
        ],
      },
    ],
  };
}
export function runHttp(stream: Stream, overrides: Partial<HttpSettings> = {}) {
  return analyzeHttp(stream, {
    intervalId: stream.intervals[0]?.id ?? '',
    threshold: '1',
    contractConfirmed: true,
    ...overrides,
  });
}

export type CumulativePoint = {
  attributes: { key: string; value: unknown }[];
  startTimeUnixNano?: string;
  timeUnixNano: string;
  count?: string | number;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
  [field: string]: unknown;
};
export type CumulativePointSpec = {
  // Stable measurement identity across both exports; stored as the `test.id` attribute.
  id: string;
  status?: number | string | boolean | null;
  overflow?: boolean;
  count: string | number;
  start?: string;
  attributes?: unknown[];
  point?: Record<string, unknown>;
};
// Cumulative explicit-bucket http.server.request.duration export with one collection timestamp.
export function httpCumulativeFixture(
  specs: CumulativePointSpec[],
  end = '2000000000',
  metric: Record<string, unknown> = {},
) {
  const dataPoints: CumulativePoint[] = specs.map((spec) => {
    const attributes: { key: string; value: unknown }[] = spec.overflow
      ? [{ key: 'otel.metric.overflow', value: { boolValue: true } }]
      : [{ key: 'test.id', value: { stringValue: spec.id } }];
    if (!spec.overflow && spec.status !== null && spec.status !== undefined)
      attributes.push({
        key: 'http.response.status_code',
        value:
          typeof spec.status === 'string'
            ? { stringValue: spec.status }
            : typeof spec.status === 'boolean'
              ? { boolValue: spec.status }
              : { intValue: String(spec.status) },
      });
    attributes.push(...((spec.attributes ?? []) as { key: string; value: unknown }[]));
    return {
      attributes,
      startTimeUnixNano: spec.start ?? '1000000000',
      timeUnixNano: end,
      count: spec.count,
      sum: Number(spec.count) === 0 ? 0 : 0.5,
      bucketCounts: [String(spec.count), '0'],
      explicitBounds: [1],
      ...spec.point,
    };
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
        scopeMetrics: [
          {
            scope: { name: 'test', version: '1' },
            metrics: [
              {
                name: 'http.server.request.duration',
                description: 'duration',
                unit: 's',
                histogram: { aggregationTemporality: 2, dataPoints },
                ...metric,
              },
            ],
          },
        ],
      },
    ],
  };
}

// Synthetic complete cumulative HTTP snapshots near the import budget: every series
// is an ordinary 200 point, and every hundredth is a 500 point with exactly 1% window 5xx.
export function largeHttpCumulativeWindow(points = 19000) {
  const snapshot = (end: string, count: string) =>
    JSON.stringify({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'http.server.request.duration',
                  unit: 's',
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: Array.from({ length: points }, (_, i) => ({
                      attributes: [
                        {
                          key: 'http.response.status_code',
                          value: { intValue: i % 100 === 0 ? '500' : '200' },
                        },
                        { key: 'id', value: { intValue: String(i) } },
                      ],
                      startTimeUnixNano: '1000000000',
                      timeUnixNano: end,
                      count,
                      sum: 0.5,
                      bucketCounts: [count, '0'],
                      explicitBounds: [1],
                    })),
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  return { before: snapshot('2000000000', '100'), after: snapshot('3000000000', '101') };
}

export type RouteSpec = {
  // `undefined` gets a unique default route; `null` omits the attribute.
  route?: string | null;
  routeValue?: unknown;
  overflow?: boolean;
  // Bucket counts for the layout below; the point count is their sum unless overridden.
  buckets?: (string | number)[];
  bounds?: number[];
  count?: string | number | null;
  attributes?: unknown[];
  point?: Record<string, unknown>;
};
// Delta explicit-bucket http.server.request.duration histogram. The default layout is
// (-inf, 0.1], (0.1, 0.5], (0.5, 1], (1, +inf): with the duration boundary 0.5 the first
// two buckets are fast, including everything exactly at 0.5, and the last two are slow.
export function routeFixture(specs: RouteSpec[], metric: Record<string, unknown> = {}) {
  const points = specs.map((spec, i) => {
    const buckets = (spec.buckets ?? [1, 0, 0, 0]).map(String);
    const total = buckets.reduce((n, b) => n + BigInt(b), 0n).toString();
    const attributes: unknown[] = spec.overflow
      ? [{ key: 'otel.metric.overflow', value: { boolValue: true } }]
      : [{ key: 'test.id', value: { intValue: String(i) } }];
    if (!spec.overflow && spec.route !== null)
      attributes.push({
        key: 'http.route',
        value: spec.routeValue ?? { stringValue: spec.route ?? `/default/${i}` },
      });
    attributes.push(...(spec.attributes ?? []));
    const count = spec.count === undefined ? total : spec.count;
    return {
      attributes,
      startTimeUnixNano: '1000000000',
      timeUnixNano: '2000000000',
      ...(count === null ? {} : { count }),
      sum: total === '0' ? 0 : 0.5,
      bucketCounts: buckets,
      explicitBounds: spec.bounds ?? [0.1, 0.5, 1],
      ...spec.point,
    };
  });
  return httpFixtureShell(points, metric);
}
function httpFixtureShell(points: Record<string, unknown>[], metric: Record<string, unknown>) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] },
        scopeMetrics: [
          {
            scope: { name: 'test', version: '1' },
            metrics: [
              {
                name: 'http.server.request.duration',
                unit: 's',
                histogram: { aggregationTemporality: 1, dataPoints: points },
                ...metric,
              },
            ],
          },
        ],
      },
    ],
  };
}
