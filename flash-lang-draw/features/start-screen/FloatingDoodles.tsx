"use client";

// The start screen's doodles, drifting slowly around the empty parts of the screen. Each one starts
// at a random spot well away from the others (so they're scattered, not lined up), wanders in a
// slowly turning direction, and bounces off the screen edges, each other and the page content
// (the `avoid` element's children: title, language buttons, text), so it never sits behind them.
// A doodle with no free space to go to (small screens) stays hidden until there is some.
//
// Positions are written straight to the DOM every animation frame; React renders the cards once.

import { useEffect, useRef, type RefObject } from "react";
import { DOODLES, DoodleCard } from "./doodles";

const EDGE = 10; // px kept clear at the screen edges
const GAP = 18; // px kept clear around the page content
const SPACING = 14; // px kept clear between doodles
const SPEED = [9, 16]; // px/s, each doodle's drift speed is picked in this range
const TURN = 0.9; // how quickly the drift direction wanders (rad/s, roughly)
const REFRESH_MS = 250; // re-measure the screen and the content this often
const STUCK_FRAMES = 30; // squeezed against the content this long (e.g. after a resize) → hide it

type Box = { l: number; t: number; r: number; b: number };
type Body = {
  x: number; y: number; // centre, px
  w: number; h: number; // on-screen size (with any CSS scale)
  lw: number; lh: number; // layout size, to place the element by its top-left corner
  heading: number; speed: number;
  shown: boolean; stuck: number;
};

const boxOf = (o: Body, pad = 0): Box => ({ l: o.x - o.w / 2 - pad, t: o.y - o.h / 2 - pad, r: o.x + o.w / 2 + pad, b: o.y + o.h / 2 + pad });
const overlap = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0;

/** steer the heading so it points along sx / sy (±1; 0 leaves that axis alone) */
function steer(o: Body, sx: number, sy: number) {
  if (sx && Math.sign(Math.cos(o.heading)) !== sx) o.heading = Math.PI - o.heading;
  if (sy && Math.sign(Math.sin(o.heading)) !== sy) o.heading = -o.heading;
}

/** push `o` out of box `k` along the shallower axis, and turn it away; true if they overlapped */
function pushOut(o: Body, k: Box): boolean {
  const a = boxOf(o);
  const ox = Math.min(a.r, k.r) - Math.max(a.l, k.l), oy = Math.min(a.b, k.b) - Math.max(a.t, k.t);
  if (ox <= 0 || oy <= 0) return false;
  if (ox < oy) { const s = o.x < (k.l + k.r) / 2 ? -1 : 1; o.x += s * ox; steer(o, s, 0); }
  else { const s = o.y < (k.t + k.b) / 2 ? -1 : 1; o.y += s * oy; steer(o, 0, s); }
  return true;
}

export default function FloatingDoodles({ avoid, dimExcept }: { avoid: RefObject<HTMLElement | null>; dimExcept: string | null }) {
  const els = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wide = matchMedia("(min-width: 1024px)");
    const bodies: Body[] = DOODLES.map(() => ({
      x: 0, y: 0, w: 0, h: 0, lw: 0, lh: 0,
      heading: Math.random() * 2 * Math.PI,
      speed: still ? 0 : SPEED[0] + Math.random() * (SPEED[1] - SPEED[0]),
      shown: false, stuck: 0,
    }));
    let W = 0, H = 0, blocks: Box[] = [];

    const write = (i: number) => {
      const el = els.current[i], o = bodies[i];
      if (!el) return;
      el.style.transform = `translate3d(${o.x - o.lw / 2}px, ${o.y - o.lh / 2}px, 0)`;
      el.style.opacity = o.shown ? "1" : "0";
    };

    /** best of many random spots: free of the content and the others, and furthest from the others */
    function place(i: number): boolean {
      const o = bodies[i];
      if (W < o.w + 2 * EDGE || H < o.h + 2 * EDGE) return false;
      let best: { x: number; y: number; score: number } | null = null;
      for (let n = 0; n < 150; n++) {
        o.x = EDGE + o.w / 2 + Math.random() * (W - o.w - 2 * EDGE);
        o.y = EDGE + o.h / 2 + Math.random() * (H - o.h - 2 * EDGE);
        const me = boxOf(o, SPACING / 2);
        if (blocks.some(k => overlap(me, k))) continue;
        let score = Infinity;
        bodies.forEach((p, j) => {
          if (j === i || !p.shown) return;
          if (overlap(me, boxOf(p, SPACING / 2))) score = -1;
          else score = Math.min(score, Math.hypot(p.x - o.x, p.y - o.y));
        });
        if (score >= 0 && (!best || score > best.score)) best = { x: o.x, y: o.y, score };
      }
      if (!best) return false;
      o.x = best.x; o.y = best.y;
      return true;
    }

    function refresh() {
      W = innerWidth; H = innerHeight;
      blocks = Array.from(avoid.current?.children ?? [], el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ l: r.left - GAP, t: r.top - GAP, r: r.right + GAP, b: r.bottom + GAP }));
      bodies.forEach((o, i) => {
        const el = els.current[i], card = el?.firstElementChild as HTMLElement | null;
        if (!el || !card) return;
        const r = card.getBoundingClientRect();
        o.w = r.width; o.h = r.height; o.lw = card.offsetWidth; o.lh = card.offsetHeight;
        const allowed = wide.matches || !DOODLES[i].wideOnly;
        if (!allowed) o.shown = false;
        else if (!o.shown) { o.shown = place(i); o.stuck = 0; }
        write(i);
      });
    }

    let raf = 0, last = performance.now(), lastRefresh = -Infinity;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - lastRefresh > REFRESH_MS) { refresh(); lastRefresh = now; }
      // a frame's timestamp can be a little earlier than `last` was read: never step backwards
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      if (still) return;
      bodies.forEach((o, i) => {
        if (!o.shown) return;
        o.heading += (Math.random() - 0.5) * 2 * TURN * Math.sqrt(dt);
        o.x += Math.cos(o.heading) * o.speed * dt;
        o.y += Math.sin(o.heading) * o.speed * dt;
        // other doodles: both move apart
        bodies.forEach((p, j) => {
          if (j <= i || !p.shown) return;
          const a = boxOf(o, SPACING / 2), b = boxOf(p, SPACING / 2);
          const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          if (ox <= 0 || oy <= 0) return;
          if (ox < oy) { const s = o.x < p.x ? -1 : 1; o.x += s * ox / 2; p.x -= s * ox / 2; steer(o, s, 0); steer(p, -s, 0); }
          else { const s = o.y < p.y ? -1 : 1; o.y += s * oy / 2; p.y -= s * oy / 2; steer(o, 0, s); steer(p, 0, -s); }
        });
        // page content, then the screen edges
        let hit = false;
        for (const k of blocks) hit = pushOut(o, k) || hit;
        if (o.x - o.w / 2 < EDGE) { o.x = EDGE + o.w / 2; steer(o, 1, 0); }
        if (o.x + o.w / 2 > W - EDGE) { o.x = W - EDGE - o.w / 2; steer(o, -1, 0); }
        if (o.y - o.h / 2 < EDGE) { o.y = EDGE + o.h / 2; steer(o, 0, 1); }
        if (o.y + o.h / 2 > H - EDGE) { o.y = H - EDGE - o.h / 2; steer(o, 0, -1); }
        // still overlapping the content after all that: it's squeezed (e.g. the window shrank)
        const me = boxOf(o);
        o.stuck = hit && blocks.some(k => overlap(me, k)) ? o.stuck + 1 : 0;
        if (o.stuck > STUCK_FRAMES) o.shown = false; // re-placed at the next refresh, if there's room
        write(i);
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [avoid]);

  return DOODLES.map((d, i) => (
    <div
      key={d.id}
      ref={el => { els.current[i] = el; }}
      className="pointer-events-none absolute left-0 top-0 opacity-0 transition-opacity duration-500 will-change-transform"
    >
      <DoodleCard d={d} dim={!!dimExcept && d.lang !== dimExcept} />
    </div>
  ));
}
