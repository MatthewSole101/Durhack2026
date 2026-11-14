import { defineConfig } from "@playwright/test";

const PORT = 3111;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // a synthetic camera, auto-granted, so getUserMedia works headless
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    // test build: exposes window.__airDraw and accepts window.__airDrawMock (see features/air-draw/engine.ts)
    command: `npx next dev -p ${PORT}`,
    env: { NEXT_PUBLIC_AIR_DRAW_TEST: "1", NEXT_DIST_DIR: ".next-e2e" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
