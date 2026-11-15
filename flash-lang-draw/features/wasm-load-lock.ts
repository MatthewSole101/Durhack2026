// Emscripten runtimes bootstrap through shared globals (self.Module / self.ModuleFactory), so two
// of them loading on the main thread at once can trip over each other. Every main-thread wasm
// runtime load (LiteRT for Quick Draw; MediaPipe only when it can't run in its worker) goes
// through this lock, one at a time. Loads inside a worker have their own globals and skip it.

let tail: Promise<unknown> = Promise.resolve();

export function withWasmLoadLock<T>(load: () => Promise<T>): Promise<T> {
  const run = tail.then(load, load);
  tail = run.catch(() => {});
  return run;
}
