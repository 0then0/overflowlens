import { analyze, type Settings } from '../src/core/analyze';
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
