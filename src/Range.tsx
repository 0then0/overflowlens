import { formatPercent, scalePercent } from './core/calculate';
import type { Rational } from './core/types';

export function fraction(r: Rational) {
  return `${r.numerator} / ${r.denominator}`;
}

export function Range({
  lower,
  upper,
  threshold,
  uncertain,
  subject,
}: {
  lower: Rational;
  upper: Rational;
  threshold: Rational;
  uncertain: boolean;
  subject: string;
}) {
  return (
    <figure
      className="range-visual"
      aria-label={`Possible ${subject} ${formatPercent(lower)} to ${formatPercent(upper)}; threshold ${formatPercent(threshold)}`}
    >
      <figcaption className="range-legend">
        <span>Possible {subject}</span>
        <span>│ Maximum allowed: {formatPercent(threshold)}</span>
      </figcaption>
      <div className="track">
        <div
          className="band"
          style={{
            left: `${scalePercent(lower)}%`,
            width: `${scalePercent(upper) - scalePercent(lower)}%`,
            minWidth: uncertain ? '3px' : '0',
          }}
        />
        <i className="endpoint" style={{ left: `${scalePercent(lower)}%` }} />
        <i className="endpoint" style={{ left: `${scalePercent(upper)}%` }} />
        <i className="threshold" style={{ left: `${scalePercent(threshold)}%` }} />
      </div>
      <div className="axis">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>
      {uncertain && (
        <p className="chart-note">
          The interval has nonzero width. Very narrow ranges use a minimum visible mark; exact
          fractions are shown below.
        </p>
      )}
    </figure>
  );
}
