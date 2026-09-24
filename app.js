import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm";

const video = document.querySelector("#camera");
const startButton = document.querySelector("#startButton");
const message = document.querySelector("#message");
const faceBadge = document.querySelector("#faceBadge");
const welcomeCard = document.querySelector("#welcomeCard");
const characterSelect = document.querySelector("#characterSelect");
const characterButtons = [...document.querySelectorAll(".character")];

let faceLandmarker;
let stream;
let animationFrameId;
let lastVideoTime = -1;
let lastInferenceAt = 0;
let faceFound = false;
let preGameScreen = "welcome";
const INFERENCE_INTERVAL_MS = 250;

const EYE_CLOSED_SCORE = 0.55;
const EYE_OPEN_SCORE = 0.25;
const CLOSED_CONFIRM_MS = 500;
const OPEN_CONFIRM_MS = 750;

const eyeTracker = {
  state: "unknown",
  candidate: null,
  candidateSince: 0,
  leftBlink: null,
  rightBlink: null,
};

const LIGHT_SAMPLE_INTERVAL_MS = 500;
const LIGHT_WINDOW_MS = 3000;
const DARK_LUMA_THRESHOLD = 45;
const LIGHT_CANVAS_WIDTH = 64;
const LIGHT_CANVAS_HEIGHT = 48;
const lightCanvas = document.createElement("canvas");
lightCanvas.width = LIGHT_CANVAS_WIDTH;
lightCanvas.height = LIGHT_CANVAS_HEIGHT;
const lightContext = lightCanvas.getContext("2d", { willReadFrequently: true });
const lightTracker = {
  active: true,
  lastSampleAt: 0,
  samples: [],
  state: "unknown",
};

function setCharacterButtonsDisabled(disabled) {
  characterButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

function maybeShowCharacterSelect() {
  if (preGameScreen !== "welcome" || !faceFound || lightTracker.state === "unknown") return;
  preGameScreen = "character-select";
  welcomeCard.hidden = true;
  characterSelect.hidden = false;
  setCharacterButtonsDisabled(lightTracker.state === "dark");
}

function setFaceState(found) {
  faceFound = found;
  faceBadge.dataset.state = found ? "found" : "missing";
  faceBadge.textContent = found ? "お顔みーつけた！" : "お顔をさがし中";
  message.textContent = found
    ? "みーつけた！ そのままお顔を映してね。"
    : "お顔が見えるように、カメラを見てね。";

  if (!found) resetEyeTracker();
  maybeShowCharacterSelect();
}

function resetEyeTracker() {
  eyeTracker.state = "unknown";
  eyeTracker.candidate = null;
  eyeTracker.candidateSince = 0;
  eyeTracker.leftBlink = null;
  eyeTracker.rightBlink = null;
  faceBadge.dataset.eyeState = "unknown";
}

function getBlendshapeScore(categories, name) {
  return categories.find((category) => category.categoryName === name)?.score ?? null;
}

function classifyEyeSample(leftBlink, rightBlink) {
  if (leftBlink === null || rightBlink === null) return null;
  if (leftBlink >= EYE_CLOSED_SCORE && rightBlink >= EYE_CLOSED_SCORE) return "closed";
  if (leftBlink <= EYE_OPEN_SCORE && rightBlink <= EYE_OPEN_SCORE) return "open";
  return null;
}

function updateEyeState(result, now) {
  const categories = result.faceBlendshapes?.[0]?.categories;
  if (!categories) {
    resetEyeTracker();
    return;
  }

  const leftBlink = getBlendshapeScore(categories, "eyeBlinkLeft");
  const rightBlink = getBlendshapeScore(categories, "eyeBlinkRight");
  eyeTracker.leftBlink = leftBlink;
  eyeTracker.rightBlink = rightBlink;

  const candidate = classifyEyeSample(leftBlink, rightBlink);
  if (!candidate) {
    eyeTracker.candidate = null;
    eyeTracker.candidateSince = 0;
    return;
  }

  if (candidate !== eyeTracker.candidate) {
    eyeTracker.candidate = candidate;
    eyeTracker.candidateSince = now;
    return;
  }

  const requiredMs = candidate === "closed" ? CLOSED_CONFIRM_MS : OPEN_CONFIRM_MS;
  if (candidate === eyeTracker.state || now - eyeTracker.candidateSince < requiredMs) return;

  eyeTracker.state = candidate;
  faceBadge.dataset.eyeState = candidate;
  window.dispatchEvent(new CustomEvent("eye-state-change", {
    detail: {
      state: candidate,
      leftBlink,
      rightBlink,
      confirmedAt: now,
    },
  }));
}

function measureBackgroundLuma() {
  if (!lightContext) return null;
  lightContext.drawImage(video, 0, 0, LIGHT_CANVAS_WIDTH, LIGHT_CANVAS_HEIGHT);
  const { data } = lightContext.getImageData(0, 0, LIGHT_CANVAS_WIDTH, LIGHT_CANVAS_HEIGHT);
  let sum = 0;
  let count = 0;

  for (let y = 0; y < LIGHT_CANVAS_HEIGHT; y += 2) {
    for (let x = 0; x < LIGHT_CANVAS_WIDTH; x += 2) {
      const inFaceZone = x >= 16 && x < 48 && y >= 8 && y < 40;
      if (inFaceZone) continue;
      const offset = (y * LIGHT_CANVAS_WIDTH + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }

  return count ? sum / count : null;
}

function updateLightState(now) {
  if (!lightTracker.active || now - lightTracker.lastSampleAt < LIGHT_SAMPLE_INTERVAL_MS) return;
  lightTracker.lastSampleAt = now;
  const luma = measureBackgroundLuma();
  if (luma === null) return;

  lightTracker.samples.push({ at: now, luma });
  lightTracker.samples = lightTracker.samples.filter((sample) => now - sample.at <= LIGHT_WINDOW_MS);

  if (lightTracker.samples.length < 5 || now - lightTracker.samples[0].at < LIGHT_WINDOW_MS - LIGHT_SAMPLE_INTERVAL_MS) return;

  const sorted = lightTracker.samples.map((sample) => sample.luma).sort((a, b) => a - b);
  const medianLuma = sorted[Math.floor(sorted.length / 2)];
  const state = medianLuma < DARK_LUMA_THRESHOLD ? "dark" : "light";
  if (state === lightTracker.state) return;

  lightTracker.state = state;
  document.documentElement.dataset.lightState = state;
  setCharacterButtonsDisabled(state === "dark");
  window.dispatchEvent(new CustomEvent("light-state-change", {
    detail: { state, medianLuma, confirmedAt: now },
  }));
  maybeShowCharacterSelect();
}

function stopPreGameLightDetection() {
  lightTracker.active = false;
  lightTracker.samples = [];
}

async function createFaceLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm"
  );

  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("このブラウザではカメラを利用できません。");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  video.srcObject = stream;
  await video.play();
}

function detectLoop(now) {
  if (
    faceLandmarker &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.currentTime !== lastVideoTime &&
    now - lastInferenceAt >= INFERENCE_INTERVAL_MS
  ) {
    lastVideoTime = video.currentTime;
    lastInferenceAt = now;
    const result = faceLandmarker.detectForVideo(video, now);
    const found = result.faceLandmarks.length > 0;
    setFaceState(found);
    if (found) updateEyeState(result, now);
    updateLightState(now);
  }
  animationFrameId = requestAnimationFrame(detectLoop);
}

async function start() {
  startButton.disabled = true;
  message.textContent = "カメラを準備しているよ…";
  faceBadge.dataset.state = "idle";
  faceBadge.textContent = "準備中";
  faceFound = false;
  preGameScreen = "welcome";
  welcomeCard.hidden = false;
  characterSelect.hidden = true;
  setCharacterButtonsDisabled(false);
  resetEyeTracker();
  lightTracker.active = true;
  lightTracker.lastSampleAt = 0;
  lightTracker.samples = [];
  lightTracker.state = "unknown";
  document.documentElement.dataset.lightState = "unknown";

  try {
    [faceLandmarker] = await Promise.all([createFaceLandmarker(), startCamera()]);
    message.textContent = "お顔をさがしているよ…";
    cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(detectLoop);
  } catch (error) {
    console.error(error);
    message.textContent = error?.name === "NotAllowedError"
      ? "カメラの許可が必要です。Safariの設定を確認してね。"
      : "カメラを始められませんでした。もう一度ためしてね。";
    faceBadge.dataset.state = "missing";
    faceBadge.textContent = "カメラ停止";
    startButton.disabled = false;
  }
}

function chooseCharacter(event) {
  const button = event.currentTarget;
  if (lightTracker.state !== "light" || button.disabled) return;

  const character = button.dataset.character;
  preGameScreen = "game";
  characterSelect.hidden = true;
  document.documentElement.dataset.character = character;
  window.dispatchEvent(new CustomEvent("game-start", {
    detail: { character, startedAt: performance.now() },
  }));
}

startButton.addEventListener("click", start);
characterButtons.forEach((button) => button.addEventListener("click", chooseCharacter));
window.addEventListener("game-start", stopPreGameLightDetection);

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animationFrameId);
  stream?.getTracks().forEach((track) => track.stop());
  faceLandmarker?.close();
});
