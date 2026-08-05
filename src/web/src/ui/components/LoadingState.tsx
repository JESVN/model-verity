export interface LoadingStateProps {
  label?: string;
  detail?: string;
  compact?: boolean;
}

export function LoadingState({
  label = "正在加载",
  detail,
  compact = false,
}: LoadingStateProps) {
  return (
    <div
      className={`loading-state${compact ? " is-compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-grid" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="loading-copy">
        <strong>{label}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
    </div>
  );
}
