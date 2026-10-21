# 場面ごとのおしゃべり

Issue #25。音声は事前生成した30本のMP3（3匹×10場面）。再生時は同一オリジンの素材だけを読み、マイク、外部TTS、APIキーを使わない。通常のbuildで音声も全件precacheされる。

## 声と場面

| キャラクター | 音声ライブラリ／スタイル | 話し方 |
| --- | --- | --- |
| うさちゃん | VOICEVOX:四国めたん／あまあま（0） | 少し高めの明るい声 |
| くまちゃん | VOICEVOX:ずんだもん／あまあま（1） | 少し低めでゆっくり |
| ねこちゃん | VOICEVOX:ずんだもん／ノーマル（3） | 高めで軽快 |

ごあいさつ、なでなで、開始案内、途中開眼、顔が戻った時、発見、暗所、夜間、顔喪失、探索の10場面。文言は `assets/voices/manifest.json` に記録。短い反応時間に合わせ、途中開眼は「今見てた？」、復帰は「いた！」という字幕の要旨を読む。ゲームの反応時間は変更しない。

閉眼中は、残り時間が15秒以上の5秒刻み（15/20/…/60秒）で短い励ましを読み上げ、最後の10秒は10から1までを毎秒読み上げる。**実際に認定された閉眼累積時間だけ**に同期し、音声側のタイマーは使わない。途中開眼/顔なし/判定不明では即停止し、再開時は残りから続け、通過した数字を繰り返さない。達成後の閉眼待機、休眠中も音を止める。背景移行、カメラ停止、終了でも再生と待機中の音声を取り消す。連打では最後の有効な反応だけを再生。遅い読み込み（1.5秒超）は後から再生しない。再生できなくても字幕とゲームは継続する。

「音あり／音なし」は今回のページ内だけの設定（保存しない）。最初のユーザー操作でAudioContextを起動する。端末の消音・音量・iOSの出力先によっては聞こえないため実機で確認する。

## 再生成

通常のビルド・CIに合成環境は不要。素材を変更する場合のみ、Python 3.10以降のvenvに `voicevox_core==0.17.0` とffmpegを用意する。

公式配布物:
- https://github.com/VOICEVOX/voicevox_core/releases/tag/0.17.0 （Python wheel）
- https://github.com/VOICEVOX/voicevox_vvm/releases/tag/0.16.4 （0.vvm）
- https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.17.3 （CPU版）
- https://github.com/r9y9/open_jtalk/releases/tag/v1.11.1 （open_jtalk_dic_utf_8-1.11.tar.gz）

モデル0.vvmをruntimeフォルダ直下へ置き、ONNX Runtimeと辞書をその下に展開する。公式ダウンローダーで導入した場合は `models/vvms/0.vvm` を直下へコピーする。

```sh
python scripts/generate-voices.py --runtime /path/to/voicevox-runtime
npm run build
npm test
npm run test:browser
```

出力は24kHz mono/64kbps、FFmpeg loudnorm（-20 LUFS / true peak -3 dB）で音量を揃える。manifestにエンジン・モデル版、モデルと素材のSHA-256、台詞、スタイル・速度・ピッチ・長さを残す。エンジン・モデル本体はアプリに同梱しない。素材の再利用にも下記規約とクレジットを適用する。

## クレジット・利用条件

VOICEVOX:四国めたん / VOICEVOX:ずんだもん

- https://voicevox.hiroshiba.jp/term/
- https://github.com/VOICEVOX/voicevox_vvm/blob/0.16.4/TERMS.txt
- https://zunko.jp/con_ongen_kiyaku.html

2026-10-20確認。クレジットをアプリの「おうちの方へ」とTHIRD_PARTY_NOTICESにも掲載。音声素材の利用者にも音声ライブラリの規約・クレジット遵守を求める。声の提供元キャラクターの公式アプリ／提携と表示しない。

## iPhoneでの受け入れ確認（未確認）

1. Safariとホーム画面版で「音あり」を確認。3匹をタップして、それぞれ声が出ること、カメラが起動しないこと。
2. 連打で古い声が続かず、「音なし」で即座に止まること。音ありに戻して次のタップで話すこと。
3. 日中に開始→閉眼→途中開眼→顔を外す／戻す→発見を一周。声が場面に合い、カウントや写真表示が変わらないこと。
4. 閉眼中・達成後の閉眼待機・終了・画面ロックでは静かなこと。ロック解除後に古い声が流れないこと。
5. 夜間／暗所ではタップしたときだけ睡眠の返事。ゲームを開始しないこと。
6. オフライン準備完了後、機内モードで再起動して声が出ること。
7. 音量・語尾・速さが子ども向けとして自然かを聴いて確認。自動デコード成功は人間の聴感評価の代わりにはしない。

## 楽しいカウントダウン（Issue #27）
- 3匹×20本の短い音声を `assets/voices/countdown/{rabbit,bear,cat}/{number}.mp3` として追加。字幕ではなく耳で残り時間が分かる。
- `voice.mjs` は既存の `game.elapsedMs` と `game.targetMs` のみ参照。ゲーム状態機械、判定の閾値やカメラは変更しない。5秒ごとの声かけは次の節目まで自然に再生させ、最後の10秒は1秒単位で切り替える。
- 音声が遅延・失敗した場合に秒数を追いかけて喋らない。音なし・開眼・顔喪失・画面ロックでは直ちに停止。再開時に既出の数字を二度読まない。
- 追加音声の作成環境はVOICEVOX ENGINEの公式CPU Dockerイメージ（生成時のversionは `assets/voices/countdown-manifest.json` に記録）。旧30本の音声を変更せず、実行時にDocker・外部TTSは不要。
- GitHub Actions `Generate countdown voices` を専用ブランチへの更新で起動し、`python3 scripts/generate-countdown.py` で60本のMP3・SHA256・再生秒数を作成してブランチにコミットする。再生成は公式Dockerイメージを起動して同じスクリプトを実行。
- iPhone実機では、10/15/20/30/45/60秒の全ラウンド、10→1の聞こえ方、途中開眼/閉眼再開、顔なし、音なし、ホーム画面版とオフライン再起動を確認する。子ども向けの発音・タイミング・音量は実機で評価する（自動テストだけで合格としない）。
