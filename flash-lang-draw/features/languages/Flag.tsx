// Simplified flags, all drawn in a 30×20 box so they can be revealed / clipped uniformly.
// (SVG rather than emoji: Windows doesn't render flag emoji.)

import type { LangCode } from "./languages";

const H3 = 20 / 3;

/** Bare shapes in a 0 0 30 20 coordinate space — wrap in an <svg> (see Flag). */
export function FlagArt({ code }: { code: LangCode }) {
  switch (code) {
    case "es":
      return <><rect width="30" height="20" fill="#c60b1e" /><rect y="5" width="30" height="10" fill="#ffc400" /></>;
    case "ru":
      return <><rect width="30" height={H3} fill="#fff" /><rect y={H3} width="30" height={H3} fill="#0039a6" /><rect y={2 * H3} width="30" height={H3} fill="#d52b1e" /></>;
    case "pl":
      return <><rect width="30" height="10" fill="#fff" /><rect y="10" width="30" height="10" fill="#dc143c" /></>;
    case "id":
      return <><rect width="30" height="10" fill="#ce1126" /><rect y="10" width="30" height="10" fill="#fff" /></>;
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
