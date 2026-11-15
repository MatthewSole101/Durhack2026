// Air Draw tunables. Behaviour and thresholds mirror docs/air-draw/hand-landmarker.html.
// Press D on the drawing page to see the live finger scores these thresholds are compared with.

export const MEDIAPIPE_VERSION = "1.2.3"; // keep in step with @mediapipe/tasks-vision in package.json
// Served from our own origin (scripts/setup-mediapipe.mjs copies them into public/); CDNs are the fallback.
export const LOCAL_WASM_BASE = "/mediapipe/wasm";
export const LOCAL_MODEL_URL = "/mediapipe/hand_landmarker.task";
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// MediaPipe confidences. Presence/tracking are below the 0.5 default so a hand that is already
// being tracked keeps being tracked when part of it slides out of frame; detection of a *new*
// hand stays strict so stray shapes in the room don't become hands.
export const HAND_DETECTION_CONF = 0.5;
export const HAND_PRESENCE_CONF = 0.3;
export const HAND_TRACKING_CONF = 0.3;
// …and when MediaPipe does lose a hand, its state (pen, pinch, shape, wheel) is remembered this long,
// and handed back if a hand reappears within HAND_MEMORY_REACH (fraction of frame width) of it.
export const HAND_MEMORY_MS = 700;
export const HAND_MEMORY_REACH = 0.3;
export const HAND_MEMORY_JOIN = 0.12; // a stroke only carries on if the hand comes back within this of where it was lost

export const PEN_COLOR = "#4fd1c5"; // starting colour, matches the UI accent
export const PEN_SIZE = 8;

// finger extension score = dist(wrist, tip) / dist(wrist, PIP joint)
//   straight finger ≈ 1.3–1.5, curled finger ≈ 0.7–0.95
export const EXT_ON = 1.15; // index counts as extended…
export const EXT_OFF = 1.05; // …and stops counting
export const CURL_MAX = 1.0; // other fingers count as curled…
export const CURL_OFF = 1.1; // …and stop counting
export const FIST_INDEX_ON = 0.95; // index balled into a fist below this (a pinching index is straighter)…
export const FIST_INDEX_OFF = 1.05; // …and no longer above this
// thumb tucked = thumb tip close to the base of the index/middle fingers (÷ palm size)
export const THUMB_CLOSED = 0.55;
export const THUMB_OPEN = 0.7;
export const POSE_FRAMES = 3; // frames a pose must hold to count (pen down, wheel pick, shape release)

// 🤏 pinch to draw: the pen sits between the thumb and index tips
export const PINCH_ON = 0.3; // thumb–index distance / palm size
export const PINCH_OFF = 0.45;
export const PEN_UP_FRAMES = 2; // a one-frame tracking blip doesn't split the stroke

// ✊✊ clench twice to undo
export const FIST_FRAMES = 2; // frames before a fist (or its release) counts
export const CLENCH_MAX_MS = 1000; // a fist held longer than this isn't a clench
export const CLENCH_GAP_MS = 700; // max time from releasing the first clench to starting the second
export const FLINCH_MS = 350; // a stroke this young when a fist forms was the hand closing, not drawing

// 👋 flick to clear: a quick sideways swipe of a hand that isn't drawing
export const FLICK_WINDOW_MS = 280; // look this far back for the motion
export const FLICK_DIST = 0.13; // hand must travel this fraction of the frame width…
export const FLICK_EXIT_SPEED = 1.0; // …or leave the frame moving sideways at this many frame widths / s
export const FLICK_COOLDOWN_MS = 1000;

export const TOAST_MS = 900;

// start screen: buttons are pressed by holding the index fingertip over them
export const DWELL_MS = 1200; // how long to hover before the press fires
export const POINTER_LOST_MS = 300; // tracking can drop a frame or two without resetting the dwell
export const DRAW_ARM_MS = 800; // after picking a language, ignore the pen briefly

export const HINTS_OPEN_MS = 9000; // gesture cheat-sheet stays open this long on the drawing page

// ✋ colour wheel: hold an open palm still → wheel opens; tilt the hand to choose; fist to pick
export const PALETTE = [ // left → right on the wheel
  { name: "Coral", color: "#ff6b6b" },
  { name: "Orange", color: "#ff9f43" },
  { name: "Sunshine", color: "#ffd166" },
  { name: "Lime", color: "#95e06c" },
  { name: "Teal", color: "#4fd1c5" },
  { name: "Sky", color: "#5ab0ff" },
  { name: "Violet", color: "#a78bfa" },
  { name: "Pink", color: "#f78fb3" },
] as const;
export const WHEEL_HOLD_MS = 700; // open palm must be held this still for this long
export const WHEEL_STILL = 0.025; // max palm drift while holding, as a fraction of frame width
export const WHEEL_UPRIGHT_DEG = 40; // hand must be roughly upright to open the wheel
export const WHEEL_SPAN_DEG = 140; // hand tilt range covering the whole palette (±70°)
export const WHEEL_COOLDOWN_MS = 1200; // after picking, before the wheel can open again

// two-hand shapes: form the symbol, pull hands apart to stretch it, release to place it
export const SHAPE_ARM_FRAMES = 3; // line / circle pose must hold this many frames
export const RECT_HOLD_MS = 300; // both-hands L pose must hold this long
export const TOUCH = 0.45; // fingertips "touching" = closer than this × palm size
export const RECT_MIN_GAP = 1.2; // L-pose index tips at least this × palm apart (touching tips = circle)
export const RECT_MIN_SIDE = 0.6; // the two L corners must be diagonal: this × palm apart in x and in y
export const SQUARE_SNAP = 0.15; // rectangles within 15% of square snap to a square
export const SHAPE_MIN_PX = 24; // shapes smaller than this (video px) are dropped
export const SHAPE_COOLDOWN_MS = 500; // after placing a shape, before another can start
