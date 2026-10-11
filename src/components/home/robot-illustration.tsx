/** Decorative artwork, independent of room or character-generation logic. */
export function RobotIllustration() {
  return (
    <svg viewBox="0 0 320 320" fill="none" aria-hidden="true" className="w-full">
      <circle cx="160" cy="160" r="138" fill="var(--accent-soft)" />
      <circle cx="160" cy="160" r="119" stroke="var(--accent)" strokeOpacity=".16" strokeDasharray="3 8" />
      <g stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M160 77V59" />
        <circle cx="160" cy="53" r="6" fill="var(--paper)" />
        <rect x="99" y="80" width="122" height="97" rx="32" fill="var(--paper)" />
        <path d="M99 115H91v27h8m122-27h8v27h-8" />
        <rect x="116" y="101" width="88" height="48" rx="20" fill="var(--accent-soft)" />
        <path d="M138 118v10m44-10v10m-33 28h22m-23 22v14m24-14v14" />
        <path d="M128 194c-13 0-21 10-21 23v35h106v-35c0-13-8-23-21-23Z" fill="var(--paper)" />
        <path d="M107 209c-13 0-21 13-21 30m127-30c13 0 21 13 21 30m-98 13v13m48-13v13" />
      </g>
      <path d="M160 228s-15-8-15-17a8 8 0 0 1 15-4 8 8 0 0 1 15 4c0 9-15 17-15 17Z" fill="var(--accent)" />
      <path d="m244 71 3-8 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="var(--accent)" />
      <circle cx="66" cy="202" r="4" fill="var(--accent)" fillOpacity=".5" />
    </svg>
  );
}
