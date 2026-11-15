// Quick Draw class names. Output index i of the model maps to entry i.
// The order is ASCII sort order ("The …" entries first: capital T sorts before lowercase) and must
// not be re-sorted. It mirrors public/models/labels.txt, which is used instead when it is valid.

export const LABEL_COUNT = 345;

export type LabelSource = "labels.txt" | "built-in";

/**
 * Canonical form of a class label, for lookups: trimmed, lowercase, and any run of spaces,
 * underscores or hyphens as one space ("Alarm_Clock", " alarm  clock", "alarm-clock" → "alarm clock").
 * Used wherever a label is matched against the flashcard words — never to rewrite the label list.
 */
export const labelKey = (label: string) => label.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** Parse a labels file. Returns null unless it has exactly LABEL_COUNT non-empty lines. */
export function parseLabels(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length === LABEL_COUNT ? lines : null;
}

// prettier-ignore
export const BUILTIN_LABELS: readonly string[] = [
  "The Eiffel Tower", "The Great Wall of China", "The Mona Lisa", "aircraft carrier", "airplane", "alarm clock",
  "ambulance", "angel", "animal migration", "ant", "anvil", "apple",
  "arm", "asparagus", "axe", "backpack", "banana", "bandage",
  "barn", "baseball", "baseball bat", "basket", "basketball", "bat",
  "bathtub", "beach", "bear", "beard", "bed", "bee",
  "belt", "bench", "bicycle", "binoculars", "bird", "birthday cake",
  "blackberry", "blueberry", "book", "boomerang", "bottlecap", "bowtie",
  "bracelet", "brain", "bread", "bridge", "broccoli", "broom",
  "bucket", "bulldozer", "bus", "bush", "butterfly", "cactus",
  "cake", "calculator", "calendar", "camel", "camera", "camouflage",
  "campfire", "candle", "cannon", "canoe", "car", "carrot",
  "castle", "cat", "ceiling fan", "cell phone", "cello", "chair",
  "chandelier", "church", "circle", "clarinet", "clock", "cloud",
  "coffee cup", "compass", "computer", "cookie", "cooler", "couch",
  "cow", "crab", "crayon", "crocodile", "crown", "cruise ship",
  "cup", "diamond", "dishwasher", "diving board", "dog", "dolphin",
  "donut", "door", "dragon", "dresser", "drill", "drums",
  "duck", "dumbbell", "ear", "elbow", "elephant", "envelope",
  "eraser", "eye", "eyeglasses", "face", "fan", "feather",
  "fence", "finger", "fire hydrant", "fireplace", "firetruck", "fish",
  "flamingo", "flashlight", "flip flops", "floor lamp", "flower", "flying saucer",
  "foot", "fork", "frog", "frying pan", "garden", "garden hose",
  "giraffe", "goatee", "golf club", "grapes", "grass", "guitar",
  "hamburger", "hammer", "hand", "harp", "hat", "headphones",
  "hedgehog", "helicopter", "helmet", "hexagon", "hockey puck", "hockey stick",
  "horse", "hospital", "hot air balloon", "hot dog", "hot tub", "hourglass",
  "house", "house plant", "hurricane", "ice cream", "jacket", "jail",
  "kangaroo", "key", "keyboard", "knee", "knife", "ladder",
  "lantern", "laptop", "leaf", "leg", "light bulb", "lighter",
  "lighthouse", "lightning", "line", "lion", "lipstick", "lobster",
  "lollipop", "mailbox", "map", "marker", "matches", "megaphone",
  "mermaid", "microphone", "microwave", "monkey", "moon", "mosquito",
  "motorbike", "mountain", "mouse", "moustache", "mouth", "mug",
  "mushroom", "nail", "necklace", "nose", "ocean", "octagon",
  "octopus", "onion", "oven", "owl", "paint can", "paintbrush",
  "palm tree", "panda", "pants", "paper clip", "parachute", "parrot",
  "passport", "peanut", "pear", "peas", "pencil", "penguin",
  "piano", "pickup truck", "picture frame", "pig", "pillow", "pineapple",
  "pizza", "pliers", "police car", "pond", "pool", "popsicle",
  "postcard", "potato", "power outlet", "purse", "rabbit", "raccoon",
  "radio", "rain", "rainbow", "rake", "remote control", "rhinoceros",
  "rifle", "river", "roller coaster", "rollerskates", "sailboat", "sandwich",
  "saw", "saxophone", "school bus", "scissors", "scorpion", "screwdriver",
  "sea turtle", "see saw", "shark", "sheep", "shoe", "shorts",
  "shovel", "sink", "skateboard", "skull", "skyscraper", "sleeping bag",
  "smiley face", "snail", "snake", "snorkel", "snowflake", "snowman",
  "soccer ball", "sock", "speedboat", "spider", "spoon", "spreadsheet",
  "square", "squiggle", "squirrel", "stairs", "star", "steak",
  "stereo", "stethoscope", "stitches", "stop sign", "stove", "strawberry",
  "streetlight", "string bean", "submarine", "suitcase", "sun", "swan",
  "sweater", "swing set", "sword", "syringe", "t-shirt", "table",
  "teapot", "teddy-bear", "telephone", "television", "tennis racquet", "tent",
  "tiger", "toaster", "toe", "toilet", "tooth", "toothbrush",
  "toothpaste", "tornado", "tractor", "traffic light", "train", "tree",
  "triangle", "trombone", "truck", "trumpet", "umbrella", "underwear",
  "van", "vase", "violin", "washing machine", "watermelon", "waterslide",
  "whale", "wheel", "windmill", "wine bottle", "wine glass", "wristwatch",
  "yoga", "zebra", "zigzag",
];
