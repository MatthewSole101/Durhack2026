// Simplified flags, all drawn in a 30×20 box so they can be revealed / clipped uniformly.
// (SVG rather than emoji: Windows doesn't render flag emoji.)

import type { LangCode } from "./languages";

const H3 = 20 / 3;

/** Bare shapes in a 0 0 30 20 coordinate space — wrap in an <svg> (see Flag). */
export function FlagArt({ code }: { code: LangCode }) {
  switch (code) {
    case "es":
      return <><rect width="30" height="20" fill="#c60b1e" /><rect y="5" width="30" height="10" fill="#ffc400" /></>;
    case "fr":
      return <><rect width="10" height="20" fill="#0055a4" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ef4135" /></>;
    case "de":
      return <><rect width="30" height={H3} fill="#000" /><rect y={H3} width="30" height={H3} fill="#dd0000" /><rect y={2 * H3} width="30" height={H3} fill="#ffce00" /></>;
    case "it":
      return <><rect width="10" height="20" fill="#009246" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ce2b37" /></>;
    case "pt":
      return <>
        <rect width="30" height="20" fill="#ff0000" /><rect width="12" height="20" fill="#006600" />
        <circle cx="12" cy="10" r="4.2" fill="none" stroke="#ffcc00" strokeWidth="1.4" />
        <path d="M10.4 7.8h3.2v3.4a1.6 1.6 0 0 1-3.2 0z" fill="#fff" stroke="#ff0000" strokeWidth="0.6" />
      </>;
    case "ja":
      return <><rect width="30" height="20" fill="#fff" /><circle cx="15" cy="10" r="6" fill="#bc002d" /></>;
    case "ko":
      return <>
        <rect width="30" height="20" fill="#fff" />
        <circle cx="15" cy="10" r="5" fill="#0047a0" />
        <path d="M10 10a5 5 0 0 1 10 0a2.5 2.5 0 0 1-5 0a2.5 2.5 0 0 0-5 0z" fill="#cd2e3a" />
        <g stroke="#000" strokeWidth="0.9">
          {([[5.5, 4, 56], [24.5, 16, 56], [24.5, 4, -56], [5.5, 16, -56]] as const).map(([x, y, a]) => (
            <g key={`${x}-${y}`} transform={`translate(${x} ${y}) rotate(${a})`}>
              <path d="M-2-1.4h4M-2 0h4M-2 1.4h4" />
            </g>
          ))}
        </g>
      </>;
  }
}

export function Flag({ code, width = 30, height = 20, className = "" }: {
  code: LangCode; width?: number; height?: number; className?: string;
}) {
  return (
    <svg
      viewBox="0 0 30 20"
      width={width}
      height={height}
      aria-hidden
      className={`shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1.5px_#1d1b16] ${className}`}
    >
      <FlagArt code={code} />
    </svg>
  );
}
