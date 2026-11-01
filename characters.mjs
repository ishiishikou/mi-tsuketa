export const CHARACTERS = Object.freeze({
  rabbit: { name: "うさちゃん", greeting: "ぴょんっ！ いっしょに あそぼ！", pet: "えへへ。なでなで だいすき！", ready: "ぴょん！ めをとじたら かくれるよ。", peek: "あれれ、今見てた？", returned: "あ、いた！ つづきから あそぼう。", found: "えへへ！ みつけてくれて うれしいな。", dark: "暗いから ねむくなっちゃった。明るくなったら あそぼうね。" },
  bear: { name: "くまちゃん", greeting: "ぎゅ〜っ。きみに あいたかった！", pet: "ぽかぽか。とっても いい きもち。", ready: "のっそり、こっそり。めをとじてね。", peek: "あれ？ 今見てた？", returned: "あ、いた！ まっていたよ。", found: "わあい！ きみと すっかり なかよし。", dark: "暗くて うとうと…。明るいときに あそぼうね。" },
  cat: { name: "ねこちゃん", greeting: "にゃん！ きょうも なかよし。", pet: "ごろごろ…。もっと なでてにゃ。", ready: "にゃん！ めをとじたら かくれるよ。", peek: "にゃ？ 今見てた？", returned: "あ、いた！ おかえりにゃ。", found: "にゃは！ みつかっちゃったにゃ。", dark: "暗いから まるくなって ねるにゃ。また明るいときにね。" },
});
export const NIGHT_MESSAGE = "もう夜だから眠いよ。また明日ね。";

export function gamePresentation(game, character) {
  const info = CHARACTERS[character];
  if (game.phase === "resting") return { motion: "sleep", text: "…", quiet: true };
  if (!game.active) return { motion: "still", text: "つづきは カメラを さいかいしてね。" };
  if (game.phase === "waiting-to-seek") return { motion: "hidden", text: "もういいよ！ めを あけて さがしてね！", quiet: true };
  if (game.faceMissingConfirmed) return { motion: "looking", text: "いなくなっちゃった。おかおを みせてね。" };
  if (game.reaction?.kind === "returned") return { motion: "hello", text: info.returned };
  if (game.reaction?.kind === "peek") return { motion: "peek", text: info.peek };
  if (game.phase === "found") return { motion: "happy", text: info.found };
  if (game.phase === "seeking") return { motion: "hidden", text: "どこに かくれたかな？ さがしてね！" };
  if (game.phase === "counting") return { motion: "sneaking", text: "そのまま めをとじていてね。" };
  if (game.phase === "paused") return { motion: "still", text: game.pauseReason === "peeking" ? "めをとじたら つづきから あそぼう！" : "そのまま めをとじていてね。" };
  return { motion: "hello", text: info.ready };
}
