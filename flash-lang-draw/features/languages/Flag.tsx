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
    case "te": // Telugu: India, with the chakra reduced to a ring and eight spokes
      return <>
        <rect width="30" height={H3} fill="#ff9933" /><rect y={H3} width="30" height={H3} fill="#fff" /><rect y={2 * H3} width="30" height={H3} fill="#138808" />
        <g stroke="#000080" fill="none">
          <circle cx="15" cy="10" r="2.5" strokeWidth="0.7" />
          <path d="M12.5 10h5M15 7.5v5M13.2 8.2l3.6 3.6M16.8 8.2l-3.6 3.6" strokeWidth="0.4" />
        </g>
      </>;
    case "yo": // Yoruba: Nigeria
      return <><rect width="10" height="20" fill="#008751" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#008751" /></>;
    case "ja":
      return <><rect width="30" height="20" fill="#fff" /><circle cx="15" cy="10" r="6" fill="#bc002d" /></>;
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
