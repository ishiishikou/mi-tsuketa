import { HideAndSeekGame, PEEK_REACTION_MS } from "./game-core.mjs";
import { EyeTracker, LightTracker, SENSOR_DEFAULTS, startMode } from "./sensing.mjs";
import { CHARACTERS, NIGHT_MESSAGE, gamePresentation } from "./characters.mjs";
import { VERSION } from "./release.mjs";
import { watchOfflineStatus } from "./offline-status.mjs";

const $ = (id) => document.getElementById(id);
const video = $("camera");
const characterButtons = [...document.querySelectorAll(".character")];
const spotButtons = [...document.querySelectorAll(".hiding-spot")];
const eyeTracker = new EyeTracker();
const lightTracker = new LightTracker();
const lightCanvas = document.createElement("canvas");
const lightContext = lightCanvas.getContext("2d", { willReadFrequently: true });
const photoCanvas = $("peekCanvas");
let game = null;
let selectedCharacter = "rabbit";
let screen = "welcome";
let stream = null;
let detector = null;
let frameId = null;
let sessionEpoch = 0;
let starting = false;
let needsResume = false;
let faceFound = false;
let lastVideoTime = -1;
let lastInferenceAt = -Infinity;
let lastPhotoId = null;
let photoTimer = null;
let sleepTapTimer = null;
let lastLightAt = -Infinity;
let displayedMode = null;
let affectionTimer = null;
let affectionMessage = "";

function clearAffection() {
  clearTimeout(affectionTimer);
  affectionTimer = null;
  affectionMessage = "";
  document.querySelectorAll(".is-loved").forEach(element => element.classList.remove("is-loved"));
}

function loveFriend(button, character, inGame = false) {
  clearAffection();
  const info = CHARACTERS[character];
  const mode = startMode(lightTracker.state);
  if (inGame) {
    if (!game?.active || !game.facePresent || game.signalStale || game.reaction || !["ready", "found"].includes(game.phase)) return;
    affectionMessage = info.pet;
  } else {
    text($("friendGreeting"), mode === "night" ? "すやすや…。また あしたね。" :
      mode === "dark" ? "すやすや…。あかるくなったら あそぼ。" : info.greeting);
  }
  button.classList.add("is-loved");
  affectionTimer = setTimeout(() => {
    clearAffection();
    text($("friendGreeting"), "いっしょに あそぼ！");
    render();
  }, 1500);
  render();
}

function text(element, value) {
  if (element.textContent !== String(value)) element.textContent = String(value);
}

function clearPhoto() {
  clearTimeout(photoTimer);
  photoTimer = null;
  photoCanvas.width = 0;
  photoCanvas.height = 0; // Erase backing pixels, not merely hide the element.
  $("peekPhoto").hidden = true;
}

function capturePeek(landmarks) {
  clearPhoto();
  if (document.hidden || !faceFound || video.readyState < 2 || !video.videoWidth) return;
  const xs = landmarks.map(p => p.x);
  const ys = landmarks.map(p => p.y);
  const left = Math.max(0, Math.min(...xs) - 0.08);
  const top = Math.max(0, Math.min(...ys) - 0.12);
  const right = Math.min(1, Math.max(...xs) + 0.08);
  const bottom = Math.min(1, Math.max(...ys) + 0.08);
  const width = (right - left) * video.videoWidth;
  const height = (bottom - top) * video.videoHeight;
  if (width <= 0 || height <= 0) return;
  photoCanvas.width = Math.max(1, Math.round(240 * width / Math.max(width, height)));
  photoCanvas.height = Math.max(1, Math.round(240 * height / Math.max(width, height)));
  const context = photoCanvas.getContext("2d");
  if (!context) return clearPhoto();
  try {
    context.drawImage(video, left * video.videoWidth, top * video.videoHeight,
      width, height, 0, 0, photoCanvas.width, photoCanvas.height);
    $("peekPhoto").hidden = false;
    photoTimer = setTimeout(clearPhoto, PEEK_REACTION_MS);
  } catch {
    clearPhoto(); // The reaction still works if a frame cannot be copied.
  }
}

function measureLight(landmarks) {
  if (!lightContext) return null;
  lightCanvas.width = 64;
  lightCanvas.height = 48;
  lightContext.drawImage(video, 0, 0, 64, 48);
  const pixels = lightContext.getImageData(0, 0, 64, 48).data;
  const xs = landmarks?.map(p => p.x) ?? [0.25, 0.75];
  const ys = landmarks?.map(p => p.y) ?? [0.16, 0.84];
  const bounds = [Math.min(...xs) - 0.08, Math.max(...xs) + 0.08,
    Math.min(...ys) - 0.08, Math.max(...ys) + 0.08];
  let sum = 0;
  let count = 0;
  for (let y = 0; y < 48; y += 2) {
    for (let x = 0; x < 64; x += 2) {
      if (x / 64 >= bounds[0] && x / 64 <= bounds[1] &&
          y / 48 >= bounds[2] && y / 48 <= bounds[3]) continue;
      const i = (y * 64 + x) * 4;
      sum += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      count++;
    }
  }
  lightCanvas.width = 0;
  lightCanvas.height = 0;
  return count ? sum / count : null;
}

function faceStatus(found) {
  faceFound = found;
  $("faceBadge").dataset.state = found ? "found" : "missing";
  text($("faceBadge"), found ? "お顔みーつけた！" : "お顔をうつしてね");
}

function applyStartMode() {
  const mode = startMode(lightTracker.state);
  document.documentElement.dataset.startMode = mode;
  if (screen === "select") {
    text($("characterTitle"), mode === "night" || mode === "dark" ? "みんな おやすみ中" : "どの子と あそぶ？");
    if (displayedMode !== mode) {
      text($("sleepMessage"), mode === "night" ? NIGHT_MESSAGE : "暗いから、みんな眠くなっちゃったみたい。");
      displayedMode = mode;
    }
  }
  // Sleeping characters stay tappable for their response; chooseCharacter enforces the gate.
  characterButtons.forEach(button => { button.disabled = starting || needsResume; });
}

function render() {
  $("welcomeCard").hidden = screen !== "welcome";
  $("characterSelect").hidden = screen !== "select";
  $("gameCard").hidden = screen !== "game";
  $("cameraBubble").hidden = !stream;
  $("resumePanel").hidden = !needsResume;
  $("resumeButton").disabled = starting;
  $("startButton").disabled = starting || !!stream || needsResume;
  text($("startButton").querySelector(".button-label"), starting ? "じゅんび中…" : "あそぶ");
  $("stopButton").hidden = !stream && !game && !starting && !needsResume;
  $("settingsFields").disabled = !!stream || starting || !!game || needsResume;
  applyStartMode();
  if (!game) return;
  const info = CHARACTERS[selectedCharacter];
  const view = gamePresentation(game, selectedCharacter);
  $("gameCard").dataset.phase = game.phase;
  $("gameCard").dataset.motion = view.motion;
  $("gameCard").dataset.quiet = String(Boolean(view.quiet));
  text($("roundLabel"), `${game.roundIndex + 1}かいめ`);
  text($("gameTitle"), game.phase === "found" ? "みーつけた！" : `${info.name}と かくれんぼ`);
  const canPet = game.active && game.facePresent && !game.reaction && !game.signalStale && ["ready", "found"].includes(game.phase);
  text($("gameInstruction"), canPet && affectionMessage ? affectionMessage : view.text);
  text($("secondsRemaining"), game.remainingSeconds);
  text($("goalSeconds"), game.targetMs / 1000);
  $("gameCharacter").firstElementChild.dataset.animal = selectedCharacter;
  $("gameCharacter").setAttribute("aria-label", `${info.name}を なでなで`);
  $("gameCharacter").disabled = !canPet;
  $("gameCharacter").setAttribute("aria-hidden", String(view.motion === "hidden"));
  const progress = Math.min(1, game.elapsedMs / game.targetMs);
  $("progressFill").style.width = `${progress * 100}%`;
  $("gameProgress").setAttribute("aria-valuemax", String(game.targetMs / 1000));
  $("gameProgress").setAttribute("aria-valuenow", String(Math.floor(game.elapsedMs / 1000)));
  $("gameProgress").setAttribute("aria-valuetext", `あと ${game.remainingSeconds}びょう`);
  $("gameCharacter").style.setProperty("--hide-progress", progress);
  $("hidingChoices").setAttribute("aria-hidden", String(game.phase !== "seeking"));
  for (const button of spotButtons) {
    const tried = game.triedSpots.has(button.dataset.spot);
    button.disabled = game.phase !== "seeking" || tried || !game.active || !game.facePresent || game.signalStale;
    button.dataset.tried = String(tried);
  }
  $("nextRoundButton").hidden = game.phase !== "found";
  $("nextRoundButton").disabled = !game.active;
  $("foundReward").hidden = game.phase !== "found";
  [...$("friendFlowers").children].forEach((flower, index) => flower.classList.toggle("bloomed", index <= game.roundIndex));
  $("restMessage").hidden = game.phase !== "resting";
  text($("guessFeedback"), game.phase === "found" ? "もういっかい あそぶ？" :
    game.phase === "seeking" && game.wrongGuess ? "しーん…。ここには いないみたい。" :
    game.phase === "seeking" ? "きになる ところを さわってみてね。" : "");
  if (game.reaction?.kind !== "peek" || !game.facePresent || !game.active) clearPhoto();
}

async function createDetector() {
  const { FaceLandmarker, FilesetResolver } = await import("./vendor/vision_bundle.mjs");
  const vision = await FilesetResolver.forVisionTasks(new URL("./vendor/wasm", import.meta.url).href);
  const options = {
    baseOptions: { modelAssetPath: new URL("./vendor/face_landmarker.task", import.meta.url).href, delegate: "GPU" },
    runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  };
  try { return await FaceLandmarker.createFromOptions(vision, options); }
  catch {
    return FaceLandmarker.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } });
  }
}

function releaseResources() {
  clearAffection();
  cancelAnimationFrame(frameId);
  frameId = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  detector?.close();
  detector = null;
  faceFound = false;
  eyeTracker.reset();
  lightCanvas.width = 0;
  lightCanvas.height = 0;
  clearPhoto();
}

function suspend() {
  if (!stream && !starting && !game) return;
  ++sessionEpoch;
  starting = false;
  game?.suspend();
  releaseResources();
  needsResume = game?.phase !== "resting";
  render();
}

async function startCamera() {
  if (starting || document.hidden) return;
  const epoch = ++sessionEpoch;
  starting = true;
  render();
  text($("message"), "お顔をうつしてね。いっしょに あそぶ じゅんび中…");
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported-camera");
    const incoming = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } });
    if (epoch !== sessionEpoch) {
      incoming.getTracks().forEach(track => track.stop());
      return;
    }
    stream = incoming;
    video.srcObject = stream;
    render();
    await video.play();
    if (epoch !== sessionEpoch) return;
    const incomingDetector = await createDetector();
    if (epoch !== sessionEpoch) { incomingDetector.close(); return; }
    detector = incomingDetector;
    stream.getVideoTracks().forEach(track => {
      track.addEventListener("ended", () => { if (epoch === sessionEpoch) suspend(); });
      track.addEventListener("mute", () => { if (epoch === sessionEpoch) suspend(); });
    });
    eyeTracker.reset();
    lastVideoTime = -1;
    lastInferenceAt = -Infinity;
    lastLightAt = -Infinity;
    if (!game) lightTracker.reset();
    game?.resume();
    needsResume = false;
    frameId = requestAnimationFrame(detectLoop);
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    releaseResources();
    game?.suspend();
    needsResume = Boolean(game) || screen === "select";
    const reason = error?.name === "NotAllowedError" ? "カメラを許可すると あそべます。Safariのカメラ設定を確認してね。" :
      !navigator.onLine ? "はじめの準備には インターネットが必要です。つないで もう一度ためしてね。" :
      "カメラを始められませんでした。ほかのカメラアプリを閉じて、もう一度ためしてね。";
    text($("message"), reason);
    text($("resumeMessage"), reason);
  } finally {
    if (epoch === sessionEpoch) { starting = false; render(); }
  }
}

function detectLoop(now) {
  if (document.hidden || !detector || !stream) return;
  try {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime &&
        now - lastInferenceAt >= SENSOR_DEFAULTS.inferenceMs) {
      lastVideoTime = video.currentTime;
      lastInferenceAt = now;
      const result = detector.detectForVideo(video, now);
      const landmarks = result.faceLandmarks?.[0];
      const found = Boolean(landmarks?.length);
      faceStatus(found);
      if (found) {
        const categories = result.faceBlendshapes?.[0]?.categories ?? [];
        const score = name => categories.find(c => c.categoryName === name)?.score ?? null;
        eyeTracker.update(score("eyeBlinkLeft"), score("eyeBlinkRight"), now);
      } else {
        eyeTracker.reset();
        clearPhoto();
      }
      if (lightTracker.active && now - lastLightAt >= 500) {
        lastLightAt = now;
        lightTracker.observe(measureLight(landmarks), now);
      }
      if (!game && screen === "welcome") {
        text($("message"), found ? "みーつけた！ そのままで まっていてね。" : "お顔が わくに入るように カメラを見てね。");
        if (found && lightTracker.state !== "unknown") screen = "select";
      }
      game?.observe({ facePresent: found, eyeState: eyeTracker.state, rawEyeState: eyeTracker.rawState }, now);
      if (game?.reaction?.kind === "peek" && game.reaction.id !== lastPhotoId) {
        lastPhotoId = game.reaction.id;
        capturePeek(landmarks);
      }
      if ($("parentInfo").open) {
        text($("diagnostics"), `顔: ${found ? "あり" : "なし"} / 目: ${eyeTracker.state}\n左: ${eyeTracker.leftBlink?.toFixed(2) ?? "—"} / 右: ${eyeTracker.rightBlink?.toFixed(2) ?? "—"}\n背景の明るさ: ${lightTracker.medianLuma?.toFixed(0) ?? "準備中"} / ${lightTracker.active ? "開始前の確認中" : "ゲーム中は確認停止"}`);
      }
    }
    game?.tick(now);
    render();
    if (game?.phase === "resting") {
      releaseResources();
      render();
      return;
    }
    frameId = requestAnimationFrame(detectLoop);
  } catch {
    suspend();
    text($("resumeMessage"), "カメラがひと休みしています。つづきから はじめよう。");
  }
}

function chooseCharacter(event) {
  if (screen !== "select" || starting || needsResume || !stream) return;
  const button = event.currentTarget;
  const mode = startMode(lightTracker.state); // Check the actual click time, including 21:00.
  applyStartMode();
  if (mode === "night" || mode === "dark") {
    text($("sleepMessage"), mode === "night" ? NIGHT_MESSAGE : CHARACTERS[button.dataset.character].dark);
    clearTimeout(sleepTapTimer);
    characterButtons.forEach(b => b.classList.remove("sleep-tap"));
    button.classList.add("sleep-tap");
    sleepTapTimer = setTimeout(() => button.classList.remove("sleep-tap"), 700);
    return;
  }
  if (mode !== "light" || !faceFound) {
    text($("characterMessage"), "お顔を カメラに うつしてね。");
    return;
  }
  selectedCharacter = button.dataset.character;
  clearAffection();
  screen = "game";
  game = new HideAndSeekGame();
  lastPhotoId = null;
  clearPhoto();
  eyeTracker.reset();
  lightTracker.stop();
  $("parentInfo").open = false;
  render();
  window.scrollTo(0, 0);
}

function endGame() {
  ++sessionEpoch;
  starting = false;
  needsResume = false;
  releaseResources();
  game = null;
  screen = "welcome";
  lastPhotoId = null;
  lightTracker.reset();
  displayedMode = null;
  text($("message"), "また あそぼうね。みんな まってるよ。");
  text($("friendGreeting"), "また なでなでしてね！");
  text($("resumeMessage"), "おかえり！ のこりの時間から あそべるよ。");
  render();
  window.scrollTo(0, 0);
}

$("startButton").addEventListener("click", startCamera);
$("resumeButton").addEventListener("click", startCamera);
$("stopButton").addEventListener("click", endGame);
$("endGameButton").addEventListener("click", endGame);
characterButtons.forEach(button => button.addEventListener("click", chooseCharacter));
document.querySelectorAll(".welcome-friend").forEach(button => {
  button.addEventListener("click", () => loveFriend(button, button.dataset.friend));
});
$("gameCharacter").addEventListener("click", () => loveFriend($("gameCharacter"), selectedCharacter, true));
spotButtons.forEach(button => button.addEventListener("click", () => {
  game?.guess(button.dataset.spot);
  render();
  if (game?.phase === "found") window.scrollTo(0, 0);
}));
$("nextRoundButton").addEventListener("click", () => {
  if (game?.nextRound()) { clearPhoto(); clearAffection(); eyeTracker.reset(); render(); window.scrollTo(0, 0); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) suspend();
  else { applyStartMode(); render(); }
});
window.addEventListener("pagehide", suspend);
window.addEventListener("pageshow", () => render());
setInterval(applyStartMode, 1000);
$("settingsForm").addEventListener("change", () => {
  if (stream || starting || game) return;
  if (!$("settingsForm").reportValidity()) return;
  const closed = Number($("closedThreshold").value);
  const open = Number($("openThreshold").value);
  if (open >= closed) {
    text($("settingsMessage"), "開眼の値は 閉眼の値より小さくしてください。");
    $("openThreshold").value = eyeTracker.config.openScore;
    $("closedThreshold").value = eyeTracker.config.closedScore;
    return;
  }
  eyeTracker.config.closedScore = closed;
  eyeTracker.config.openScore = open;
  lightTracker.threshold = Number($("darkThreshold").value);
  text($("settingsMessage"), "この画面を閉じるまで有効です。次の「あそぶ」から適用します。");
});
$("resetSettings").addEventListener("click", () => {
  if (stream || starting || game) return;
  eyeTracker.config = { ...SENSOR_DEFAULTS };
  lightTracker.threshold = SENSOR_DEFAULTS.darkLuma;
  $("settingsForm").reset();
  text($("settingsMessage"), "標準の値に戻しました。");
});
text($("appVersion"), VERSION);
render();

watchOfflineStatus(navigator.serviceWorker, message => text($("offlineStatus"), message));
