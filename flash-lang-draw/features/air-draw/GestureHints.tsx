"use client";

// Gesture cheat-sheet for the drawing page. Open when the page opens, and always tucks itself away
// into a small "How to draw" pill after HINTS_OPEN_MS (unless it was hidden and brought back by
// then); click the pill (or press H) to bring it back. The whole open panel is one big "hide"
// target, for the mouse and for a fingertip held over it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { HINTS_OPEN_MS } from "./constants";
import { CORNER_BUTTON } from "./corner-button";
import type { MicState } from "./snap-audio";

// how snaps are being detected right now (shown under the cheat-sheet, and next to the pill)
const MIC_NOTE: Record<MicState, string | null> = {
  on: null,
  starting: null,
  click: "🎤 Click anywhere once so snaps can be heard",
  off: "🎤 Microphone off: snaps are judged by sight only",
};

// tiny line-art icons for the two-hand shapes
const ShapeIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export default function GestureHints({ mic = "off" }: { mic?: MicState }) {
  const [open, setOpen] = useState(true);
  /** brought back by the user after being hidden: then it stays until they hide it again */
  const reopened = useRef(false);
  const show = (o: boolean) => { if (o) reopened.current = true; setOpen(o); };

  useEffect(() => {
    // the first auto-hide always happens, even if H was pressed in the meantime
    const timer = setTimeout(() => { if (!reopened.current) setOpen(false); }, HINTS_OPEN_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "h") setOpen(o => { if (!o) reopened.current = true; return !o; });
    };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div data-testid="gesture-hints" data-open={open} className="font-hand fixed bottom-5 right-5 z-10 flex flex-col items-end gap-2 text-[#1d1b16]">
      {MIC_NOTE[mic] && (
        <div data-testid="mic-note" className="font-toon max-w-[290px] rounded-lg border-2 border-[#1d1b16] bg-[#fff3c4] px-2.5 py-1 text-xs font-semibold">
          {MIC_NOTE[mic]}
        </div>
      )}
      {open ? (
        // the whole panel hides it: hovering anywhere on it shows the hand cursor's ring, and a click
        // anywhere (or a fingertip held over it) tucks it away. The × is the keyboard-reachable button.
        <div
          onClick={() => show(false)}
          data-hand-target
          title="Click to hide"
          className="group w-[290px] rotate-[-1deg] cursor-pointer rounded-xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-3 transition-[translate,background-color] duration-150 hover:-translate-y-0.5 hover:bg-[#fff8de] data-[hand-hover]:-translate-y-0.5 data-[hand-hover]:bg-[#fff8de]"
        >
          <div className="mb-1 flex items-center justify-between">
            <b className="font-toon text-sm">How to draw</b>
            <button
              type="button"
              aria-label="Hide hints"
              className="font-toon -mr-1 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold leading-none text-[#1d1b16]/60 group-hover:bg-[#1d1b16]/10 group-data-[hand-hover]:bg-[#1d1b16]/10"
            >
              hide <span className="text-base">×</span>
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            <Hint icon="🤏" title="Draw">pinch thumb and index together, then move; open or close your hand to stop</Hint>
            <Hint icon="👈" title="Undo">fist, thumb pointing left</Hint>
            <Hint icon="👉" title="Redo">fist, thumb pointing right</Hint>
            <Hint icon="👏" title="Clear">clap your hands, or 🫰 snap your fingers</Hint>
            <Hint icon="✋" title="Colour">hold an open palm still, tilt to choose, fist to pick</Hint>
          </ul>
          <div className="font-toon mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wider text-[#1d1b16]/50">
            Two hands · move to place, pull apart to grow, let go to drop
          </div>
          <ul className="flex flex-col gap-1">
            <Hint icon={<ShapeIcon d="M4 19L20 5" />} title="Line">pinch with both hands at once</Hint>
            <Hint icon={<ShapeIcon d="M4 5h16v14H4z" />} title="Rectangle">an L with each hand; the L corners are opposite corners</Hint>
            <Hint icon={<ShapeIcon d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z" />} title="Circle">make an O with both hands (index tips and thumb tips touching), pull apart, close hands to drop</Hint>
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => show(true)}
          data-hand-target
          data-hand-after-leave
          className={CORNER_BUTTON}
        >
          How to draw ?
        </button>
      )}
    </div>
  );
}

function Hint({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[1rem] leading-tight">
      <span className="flex w-6 shrink-0 justify-center text-xl leading-none" aria-hidden>{icon}</span>
      <span><b className="font-toon text-[13px]">{title}</b> · {children}</span>
    </li>
  );
}
