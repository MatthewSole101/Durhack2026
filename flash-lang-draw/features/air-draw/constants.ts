// Air Draw tunables. Distances marked "÷ palm" are divided by the hand's palm length
// (wrist → middle knuckle), so they work at any distance from the camera.

export const MEDIAPIPE_VERSION = "1.2.3"; // keep in step with @mediapipe/tasks-vision in package.json
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
// Lower than MediaPipe's 0.5 defaults so a hand that is partly out of frame keeps being tracked
// (the landmark model extrapolates the missing part) instead of vanishing.
export const MIN_HAND_DETECTION = 0.5;
export const MIN_HAND_PRESENCE = 0.3;
export const MIN_TRACKING = 0.3;

export const PEN_COLOR = "#4fd1c5"; // starting colour, matches the UI accent
export const PEN_SIZE = 8;

// finger extension score = dist(wrist, tip) / dist(wrist, PIP joint)
//   straight finger ≈ 1.3–1.5, curled finger ≈ 0.7–0.95
export const EXT_ON = 1.15; // a finger counts as extended…
export const EXT_OFF = 1.05; // …and stops counting
export const CURL_MAX = 1.0; // a finger counts as curled…
export const CURL_OFF = 1.1; // …and stops counting
// thumb tucked = thumb tip close to the base of the index/middle fingers (÷ palm)
export const THUMB_CLOSED = 0.55;
export const THUMB_OPEN = 0.7;

// 🤏 pen: pinch thumb and index together to draw
// gap = thumb tip ↔ nearest point of the index finger's last segment ÷ palm (fingertips touching ≈ 0.1–0.25)
export const PINCH_ON = 0.25; // pinched below this (gap to the outer half of the index's last segment)…
export const PINCH_OFF = 0.45; // …and let go above this (≈ 1–2 cm apart): visibly open fingers don't draw
export const PINCH_MIN_INDEX = 0.8; // index extension a pinch needs to start; a fist's thumb rests on a curled index
export const PINCH_START_SPEED = 4; // a pinch can't start while the pinch point moves faster than this (palm lengths / s): motion blur
export const PEN_DOWN_MS = 150; // a pinch must last this long to draw (a finger brushing past isn't a pinch); its ink is kept
export const PEN_UP_MS = 200; // the pen lifts only after the pinch has been open this long; re-pinch sooner and the stroke goes on
export const PEN_BRIDGE = 0.2; // after tracking drops mid-stroke, continue the stroke if the pen is back within this × frame width

// a hand that drops out of tracking (e.g. partly off-screen) is remembered this long: its stroke,
// pinch and shape stay alive, and a hand reappearing near it picks them back up
export const HAND_MEMORY_MS = 900;
export const HAND_MATCH = 0.35; // max distance (× frame width) between a remembered hand and a new detection

// 👈 / 👉 undo / redo: a fist with the thumb pointing sideways (as you see it on screen)
export const THUMB_POINT_EXT = 0.75; // thumb tip ↔ index knuckle ÷ palm: the thumb is sticking out
export const THUMB_AXIS_DEG = 35; // thumb within this many degrees of horizontal
export const THUMB_HOLD_MS = 280; // pose held this long fires once; drop it to fire again
export const THUMB_REARM_MS = 150;
export const THUMB_AFTER_PINCH_MS = 500; // not straight out of a pinch: closing the hand after drawing often leaves the thumb out

// 🫰 snap your fingers to clear: seen (thumb pressed on the end of the middle finger, then the two
// fly apart) and heard (a sharp click on the microphone, detected locally: see snap-audio.ts)
export const SNAP_READY = 0.4; // thumb tip ↔ middle fingertip or last joint ÷ palm (2D): pressed together
export const SNAP_REACH = 1.0; // middle fingertip at least this far from the wrist ÷ palm (in a fist it's folded into the palm)
export const SNAP_OPEN = 0.5; // thumb ↔ middle fingertip this far apart: snapped
export const SNAP_RELEASE_MS = 400; // …within this of the last "ready" frame
export const SNAP_SYNC_MS = 400; // a snap sound counts if the hand let go within this of it…
export const SNAP_HEARD_MS = 500; // …or was in the ready pose up to this long before it (the snap is often too fast to see)
export const SNAP_PREP_MS = 60; // without a microphone, the ready pose must be seen this long before letting go
export const SNAP_COOLDOWN_MS = 1000;
export const SNAP_DISCARD_MS = 800; // ink started this recently came from getting into position: dropped, not kept for undo

export const TOAST_MS = 900;

// start screen: buttons are pressed by holding the index fingertip over them
export const DWELL_MS = 1200; // how long to hover before the press fires
export const POINTER_LOST_MS = 300; // tracking can drop a frame or two without resetting the dwell
export const DRAW_ARM_MS = 800; // after Start, ignore the pen briefly

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
export const WHEEL_HOLD_MS = 1000; // open palm must be held this still for this long (a resting hand shouldn't open it)
export const WHEEL_STILL = 0.025; // max palm drift while holding, as a fraction of frame width
export const WHEEL_UPRIGHT_DEG = 40; // hand must be roughly upright to open the wheel
export const WHEEL_SPAN_DEG = 140; // hand tilt range covering the whole palette (±70°)
export const WHEEL_PICK_MS = 100; // fist held this long picks

// two-hand shapes: form the gesture, move / pull the hands apart to place and size it, let go to drop it
export const LINE_SYNC_MS = 600; // line: both hands start pinching within this of each other…
export const LINE_STILL = 0.03; // …or both are pinching and neither has moved more than this × frame width
export const LINE_ARM_MS = 120; // either way, held this long (any ink they made meanwhile is removed)
export const CIRCLE_ARM_MS = 200; // circle: both hands held in an O this long
export const CIRCLE_TOUCH = 0.5; // the two index tips (and the two thumb tips) "touch" = closer than this ÷ palm
export const CIRCLE_HOLE = 0.5; // within each hand, thumb and index tips at least this ÷ palm apart (it's an O, not a pinch)
export const RECT_HOLD_MS = 350; // rectangle: both hands in an L this long
export const RECT_MIN_GAP = 1.2; // L corners must be at least this ÷ palm apart
export const SQUARE_SNAP = 0.15; // rectangles within 15% of square snap to a square
export const SHAPE_RELEASE_MS = 200; // a hand out of the shape's pose this long drops the shape
export const SHAPE_MIN_PX = 24; // shapes smaller than this (video px) are dropped
export const CIRCLE_SEGMENTS = 64; // a placed circle is stored as a polygon with this many sides
export const SHAPE_COOLDOWN_MS = 500; // after placing a shape, before another can start
export const ACTION_COOLDOWN_MS = 600; // after a shape or a colour pick: no undo / redo / clear / wheel

export const SOLVED_MS = 1600; // how long a solved word stays up before the next one

export const PREDICT_CONFIDENCE_THRESH = 0.75; // How confident a prediction has to be to be counted as correct