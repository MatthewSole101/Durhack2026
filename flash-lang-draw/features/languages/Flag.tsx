// Simplified flags, all drawn in a 30×20 box so they can be revealed / clipped uniformly.
// (SVG rather than emoji: Windows doesn't render flag emoji.)

import type { LangCode } from "./languages";

/** Bare shapes in a 0 0 30 20 coordinate space — wrap in an <svg> (see Flag). */
export function FlagArt({ code }: { code: LangCode }) {
  switch (code) {
    case "es":
      return <><rect width="30" height="20" fill="#c60b1e" /><rect y="5" width="30" height="10" fill="#ffc400" /></>;
    case "uk":
      return <><rect width="30" height="10" fill="#0057b7" /><rect y="10" width="30" height="10" fill="#ffd700" /></>;
    case "pl":
      return <><rect width="30" height="10" fill="#fff" /><rect y="10" width="30" height="10" fill="#dc143c" /></>;
    case "id":
      return <><rect width="30" height="10" fill="#ce1126" /><rect y="10" width="30" height="10" fill="#fff" /></>;
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
