// "Langdöödle" title: chunky outlined letters in alternating colours that pop in, then bob,
// with a white scribble underline that draws itself in. The o's are drawn without their dots.

export const TITLE = "Langdöödle";
const LETTER_COLORS = ["#ffd166", "#ff6b6b", "#4fd1c5", "#f78fb3", "#7bdff2", "#95e06c"];

/** `revealed`: the opening paper is gone, so the underline can draw itself in */
export default function TitleLogo({ revealed }: { revealed: boolean }) {
  return (
    <>
      <h1
        aria-label={TITLE}
        className="font-toon lt-title flex select-none text-[clamp(3rem,12vw,8rem)] font-bold leading-none"
      >
        {TITLE.split("").map((ch, i) => (
          <span
            key={i}
            aria-hidden
            className="lt-letter inline-block"
            style={{
              color: LETTER_COLORS[i % LETTER_COLORS.length],
              ["--i" as string]: i,
              ["--tilt" as string]: `${i % 2 ? 4 : -4}deg`,
            }}
          >
            {ch === "ö" ? "o" : ch}
          </span>
        ))}
      </h1>

      {/* scribbled underline */}
      <svg viewBox="0 0 400 24" className="-mt-4 w-[min(420px,70vw)]" fill="none" aria-hidden>
        <path
          className={`lt-scribble ${revealed ? "lt-scribble-go" : ""}`}
          pathLength={1}
          d="M6 14 Q60 4 120 13 T240 12 T394 10"
          stroke="#fffdf5"
          strokeWidth={5}
          strokeLinecap="round"
        />
      </svg>
    </>
  );
}
