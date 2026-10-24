/** Bulkhead mark: a hull cross-section split by two bulkheads. */
export function Mark({ size = 26, dark = true }: { size?: number; dark?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill={dark ? "#15171A" : "transparent"} />
      <path
        d="M5 11h22l-3 11H8z"
        fill="none"
        stroke={dark ? "#F3F0E8" : "#15171A"}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12.3 11v11M19.7 11v11" stroke="#E0531F" strokeWidth="2" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      Bulkhead
    </span>
  );
}
