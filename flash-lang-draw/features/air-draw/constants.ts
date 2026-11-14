// Air Draw tunables. Behaviour and thresholds mirror docs/air-draw/hand-landmarker.html.

export const MEDIAPIPE_VERSION = "1.2.3"; // keep in step with @mediapipe/tasks-vision in package.json
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export const PEN_COLOR = "#4fd1c5"; // single fixed colour, matches the UI accent
export const PEN_SIZE = 8;

// finger extension score = dist(wrist, tip) / dist(wrist, PIP joint)
//   straight finger ≈ 1.3–1.5, curled finger ≈ 0.7–0.95
export const EXT_ON = 1.15; // index counts as extended…
export const EXT_OFF = 1.05; // …and stops counting
export const CURL_MAX = 1.0; // other fingers count as curled…
export const CURL_OFF = 1.1; // …and stop counting
// thumb tucked = thumb tip close to the base of the index/middle fingers (÷ palm size)
export const THUMB_CLOSED = 0.55;
export const THUMB_OPEN = 0.7;
export const POSE_FRAMES = 3; // frames a pose must hold before pen goes down / up

export const PINCH_ON = 0.3; // thumb–index distance / palm size
export const PINCH_OFF = 0.45;
export const TAP_MAX_MS = 450; // a pinch longer than this isn't a "tap"
export const DOUBLE_GAP_MS = 550; // max time between the two pinch taps

export const FLICK_WINDOW_MS = 220; // look this far back for the motion
export const FLICK_DIST = 0.16; // hand must travel this fraction of the frame width
export const FLICK_COOLDOWN_MS = 1200;

export const TOAST_MS = 900;

// start screen: buttons are pressed by holding the index fingertip over them
export const DWELL_MS = 1200; // how long to hover before the press fires
export const POINTER_LOST_MS = 300; // tracking can drop a frame or two without resetting the dwell
export const DRAW_ARM_MS = 800; // after Start, ignore the pen briefly so the pressing finger doesn't draw

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
export const SHAPE_ARM_FRAMES = 3; // line / triangle pose must hold this many frames
export const RECT_HOLD_MS = 500; // both-hands L pose must hold this long (it's close to the triangle pose)
export const TOUCH = 0.45; // fingertips "touching" = closer than this × palm size
export const RECT_MIN_GAP = 1.2; // L-pose fingertips must be at least this × palm apart
export const SQUARE_SNAP = 0.15; // rectangles within 15% of square snap to a square
export const SHAPE_MIN_PX = 24; // shapes smaller than this (video px) are dropped
export const SHAPE_COOLDOWN_MS = 500; // after placing a shape, before another can start
