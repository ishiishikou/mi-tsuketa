import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm";

const video = document.querySelector("#camera");
const startButton = document.querySelector("#startButton");
const message = document.querySelector("#message");
const faceBadge = document.querySelector("#faceBadge");

let faceLandmarker;
let stream;
let animationFrameId;
let lastVideoTime = -1;
let lastInferenceAt = 0;
const INFERENCE_INTERVAL_MS = 250;

// MediaPipe eyeBlink blendshape scores approach 1 as the eyelid closes.
// Keep a dead band between open/closed so borderline samples do not flap state.
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

function setFaceState(found) {
  faceBadge.dataset.state = found ? "found" : "missing";
  faceBadge.textContent = found ? "お顔みーつけた！" : "お顔をさがし中";
  message.textContent = found
    ? "みーつけた！ そのままお顔を映してね。"
    : "お顔が見えるように、カメラを見てね。";

  if (!found) resetEyeTracker();
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
  }
  animationFrameId = requestAnimationFrame(detectLoop);
}

async function start() {
  startButton.disabled = true;
  message.textContent = "カメラを準備しているよ…";
  faceBadge.dataset.state = "idle";
  faceBadge.textContent = "準備中";
  resetEyeTracker();

  try {
    // Model assets are downloaded, but video frames stay in this browser process.
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

startButton.addEventListener("click", start);

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animationFrameId);
  stream?.getTracks().forEach((track) => track.stop());
  faceLandmarker?.close();
});
