"use client";

// Fingertip cursor for the start screen. Hold it over any element marked `data-hand-target`
// and a progress widget next to the finger fills up; when it's full the element is clicked, so
// hand presses and mouse clicks go through the same onClick.
//   - targets with `data-hand-flag="<lang>"`: that language's flag is painted in, left to right
//   - other targets: a ring fills
//
// Updated imperatively every camera frame; React only re-renders when the hovered flag changes.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { DWELL_MS, POINTER_LOST_MS } from "@/features/air-draw/constants";
import type { Pointer } from "@/features/air-draw/engine";
import { FlagArt } from "@/features/languages/Flag";
import { LANGUAGES, type LangCode } from "@/features/languages/languages";

export type HandCursorHandle = { update: (p: Pointer) => void };

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;
const HIT_PAD = 6; // px of slack around a target…
const KEEP_PAD = 22; // …and more once it's hovered, so jitter at the edge doesn't restart the dwell
const FLAG_CLIP_ID = "hand-cursor-flag-paint"; // only one cursor on the page

const isLang = (v: string | undefined): v is LangCode => LANGUAGES.some(l => l.code === v);

function isDisabled(el: HTMLElement) {
  return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
}

function findTarget(x: number, y: number, current: HTMLElement | null): HTMLElement | null {
  const inside = (el: HTMLElement, pad: number) => {
    const r = el.getBoundingClientRect();
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  };
  if (current?.isConnected && !isDisabled(current) && inside(current, KEEP_PAD)) return current;
  for (const el of document.querySelectorAll<HTMLElement>("[data-hand-target]")) {
    if (!isDisabled(el) && inside(el, HIT_PAD)) return el;
  }
  return null;
}

/**
 * targetsOnly: show the cursor only while it's over a target (the drawing page, where the
 * engine draws its own pen cursor and the only target is the back button).
 */
export default function HandCursor({ ref, targetsOnly = false }: { ref?: Ref<HandCursorHandle>; targetsOnly?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const arcRef = useRef<SVGCircleElement>(null);
  const paintRef = useRef<SVGRectElement>(null); // flag reveal (clip width)
  const outlineRef = useRef<SVGRectElement>(null); // flag outline, drawn as it fills
  const st = useRef({ target: null as HTMLElement | null, since: 0, fired: false, lastSeen: -1e9 });
  const [flag, setFlag] = useState<LangCode | null>(null);
  const targetsOnlyRef = useRef(targetsOnly);
  useEffect(() => { targetsOnlyRef.current = targetsOnly; }, [targetsOnly]);

  function setTarget(el: HTMLElement | null) {
    const s = st.current;
    if (el === s.target) return;
    s.target?.removeAttribute("data-hand-hover");
    el?.setAttribute("data-hand-hover", "");
    s.target = el; s.since = performance.now(); s.fired = false;
    const code = el?.dataset.handFlag;
    setFlag(isLang(code) ? code : null);
  }

  function showProgress(progress: number) {
    arcRef.current?.style.setProperty("stroke-dashoffset", String(RING_C * (1 - progress)));
    paintRef.current?.setAttribute("width", String(30 * progress));
    outlineRef.current?.style.setProperty("stroke-dashoffset", String(1 - progress));
  }

  useImperativeHandle(ref, () => ({
    update(p) {
      const root = rootRef.current;
      if (!root) return;
      const s = st.current, now = performance.now();

      if (!p) {
        // brief dropouts keep the dwell going; a longer loss hides the cursor and resets it
        if (now - s.lastSeen > POINTER_LOST_MS) { root.dataset.state = "hidden"; setTarget(null); }
        return;
      }
      s.lastSeen = now;
      root.style.transform = `translate(${p.x}px, ${p.y}px)`;

      setTarget(findTarget(p.x, p.y, s.target));
      if (!s.target) { root.dataset.state = targetsOnlyRef.current ? "hidden" : "idle"; return; }
      if (s.fired) return; // pressed already: stays "done" until the finger leaves this target

      const progress = Math.min((now - s.since) / DWELL_MS, 1);
      showProgress(progress);
      root.dataset.state = "dwell";
      if (progress >= 1) {
        s.fired = true;
        root.dataset.state = "done";
        s.target.click();
      }
    },
  }), []);

  // don't leave a stale hover highlight behind when the cursor goes away
  useEffect(() => () => st.current.target?.removeAttribute("data-hand-hover"), []);

  // shared show/hide for the progress widget (ring or flag), up and right of the finger
  const widget =
    "absolute scale-50 opacity-0 transition-[opacity,scale] duration-150 group-data-[state=dwell]:scale-100 group-data-[state=dwell]:opacity-100 group-data-[state=done]:scale-110 group-data-[state=done]:opacity-100";

  return (
    <div
      ref={rootRef}
      data-testid="hand-cursor"
      data-state="hidden"
      data-flag={flag ?? undefined}
      aria-hidden
      className="group pointer-events-none fixed left-0 top-0 z-50 transition-opacity duration-150 data-[state=hidden]:opacity-0"
    >
      {/* fingertip dot */}
      <div className="absolute -left-[11px] -top-[11px] h-[22px] w-[22px] rounded-full border-[3px] border-[#1d1b16] bg-[#fffdf5] shadow-[0_0_0_3px_rgba(79,209,197,0.6),2px_3px_0_3px_rgba(0,0,0,0.35)] transition-transform group-data-[state=dwell]:scale-75 group-data-[state=done]:scale-75" />

      {flag ? (
        // a little flag on a pole, painted in left to right as the dwell progresses
        <svg
          key={flag}
          data-testid="hand-cursor-flag"
          viewBox="0 0 44 36"
          width="58"
          height="47"
          className={`${widget} left-[8px] top-[-60px] origin-bottom-left drop-shadow-[2px_3px_0_rgba(0,0,0,0.45)]`}
        >
          <clipPath id={FLAG_CLIP_ID}>
            <rect ref={paintRef} x="0" y="0" width="0" height="20" />
          </clipPath>
          <path d="M5 34V3" stroke="#1d1b16" strokeWidth="3" strokeLinecap="round" />
          <circle cx="5" cy="3" r="2.4" fill="#ffd166" stroke="#1d1b16" strokeWidth="1.2" />
          {/* faint ghost of the whole flag, so you can see what's coming */}
          <rect x="7" y="4" width="30" height="20" rx="1.5" fill="#fffdf5" fillOpacity="0.55" />
          <svg x="7" y="4" width="30" height="20" viewBox="0 0 30 20">
            <g clipPath={`url(#${FLAG_CLIP_ID})`}><FlagArt code={flag} /></g>
          </svg>
          <rect
            ref={outlineRef}
            x="7" y="4" width="30" height="20" rx="1.5"
            fill="none" stroke="#1d1b16" strokeWidth="1.6" strokeLinejoin="round"
            pathLength={1} strokeDasharray="1" strokeDashoffset="1"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 40 40" width="40" height="40" className={`${widget} left-[10px] top-[-50px] -rotate-90`}>
          <circle cx="20" cy="20" r={RING_R + 2.5} fill="#1d1b16" fillOpacity={0.55} />
          <circle cx="20" cy="20" r={RING_R} fill="none" stroke="#fffdf5" strokeOpacity={0.35} strokeWidth={5} />
          <circle
            ref={arcRef}
            cx="20" cy="20" r={RING_R}
            fill="none" stroke="#4fd1c5" strokeWidth={5} strokeLinecap="round"
            strokeDasharray={RING_C} strokeDashoffset={RING_C}
          />
        </svg>
      )}
    </div>
  );
}
