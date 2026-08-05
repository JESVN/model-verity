interface ProgressRingProps {
  /** 0–1 */
  value: number;
  profileLabel: string;
}

const R = 66;
const C = 2 * Math.PI * R;

export function ProgressRing({ value, profileLabel }: ProgressRingProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const offset = C * (1 - clamped);
  const pct = Math.round(clamped * 100);

  return (
    <div
      className="ring-wrap"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg viewBox="0 0 148 148" aria-hidden>
        <defs>
          <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f4b59c" />
            <stop offset="45%" stopColor="#e56a4a" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx="74" cy="74" r={R} />
        <circle
          className="ring-value"
          cx="74"
          cy="74"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="ring-center">
        <div className="ring-pct">{pct}%</div>
        <div className="ring-profile">{profileLabel}</div>
      </div>
    </div>
  );
}
