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

function setFaceState(found) {
  faceBadge.dataset.state = found ? "found" : "missing";
  faceBadge.textContent = found ? "お顔みーつけた！" : "お顔をさがし中";
  message.textContent = found
    ? "みーつけた！ そのままお顔を映してね。"
    : "お顔が見えるように、カメラを見てね。";
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
    setFaceState(result.faceLandmarks.length > 0);
  }
  animationFrameId = requestAnimationFrame(detectLoop);
}

async function start() {
  startButton.disabled = true;
  message.textContent = "カメラを準備しているよ…";
  faceBadge.dataset.state = "idle";
  faceBadge.textContent = "準備中";

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
