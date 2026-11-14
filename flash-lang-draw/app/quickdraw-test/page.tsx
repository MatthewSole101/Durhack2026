import type { Metadata } from "next";
import DoodleCanvas from "./DoodleCanvas";

export const metadata: Metadata = {
  title: "QuickDraw Test · LiteRT.js",
  description:
    "Real-time doodle recognition running a local TFLite QuickDraw model in the browser with LiteRT.js.",
};

export default function QuickDrawTestPage() {
  return (
    <div className="flex flex-1 justify-center bg-zinc-50 px-4 py-10 font-sans dark:bg-black sm:px-8">
      <main className="flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            QuickDraw doodle recognition
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            A standalone test bench for the local{" "}
            <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/[.08]">
              quickdraw_model.tflite
            </code>{" "}
            model, running entirely in your browser on the LiteRT.js Wasm
            accelerator. Draw with a mouse, finger, or stylus — the Top-5
            predictions refresh every 200&nbsp;ms and on every stroke release.
          </p>
        </header>
        <DoodleCanvas />
      </main>
    </div>
  );
}
