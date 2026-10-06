// The Black Cat mark: a minimal cat head — two ears, two contrasting eyes on black.
// Inline SVG so it renders identically everywhere (the old 🐈‍⬛ emoji didn't) and the
// eyes can blink (`.cat-eyes` animation) for the brand's one small sign of life.
export function CatMark({ size = 20, blink = false }: { size?: number; blink?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
    >
      {/* head + ears, one silhouette */}
      <path
        d="M5 13 L4 4 L12 8.5 C13.2 8.1 14.6 7.9 16 7.9 C17.4 7.9 18.8 8.1 20 8.5 L28 4 L27 13
           C28.2 15 29 17.2 29 19.5 C29 26 23.2 29.5 16 29.5 C8.8 29.5 3 26 3 19.5 C3 17.2 3.8 15 5 13 Z"
        fill="#000"
        stroke="var(--brand-accent, var(--accent))"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* cat-eye slits */}
      <g className={blink ? "cat-eyes" : undefined} fill="var(--brand-accent, var(--accent))">
        <ellipse cx="11.2" cy="18.6" rx="2.1" ry="3.1" />
        <ellipse cx="20.8" cy="18.6" rx="2.1" ry="3.1" />
        <ellipse cx="11.2" cy="18.6" rx="0.7" ry="2.4" fill="#000" />
        <ellipse cx="20.8" cy="18.6" rx="0.7" ry="2.4" fill="#000" />
      </g>
    </svg>
  );
}
