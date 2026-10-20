# Third-party resources

- MediaPipe Tasks Vision, version `0.10.22-rc.20250304`, from `@mediapipe/tasks-vision` (Google): Apache-2.0. Original license notices remain in the distributed JavaScript/WASM resources. Source: https://github.com/google-ai-edge/mediapipe . License: https://www.apache.org/licenses/LICENSE-2.0 .
- Face Landmarker float16 model, version `1`, distributed by Google: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task . Task/model documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker .
- Model SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.

Builds download these fixed resources and serve them from the same origin. No camera data is passed to these source hosts. The rabbit app icon and forest props are repository-native SVGs. The three plush animal sprite strips are original illustrations generated with the built-in image generation tool for this project, with no photographic inputs or third-party characters. Their prompts and provenance are recorded in `docs/art-direction.md`. All illustrations are served and cached from the same origin.

## おしゃべり音声（assets/voices）

VOICEVOX:四国めたん / VOICEVOX:ずんだもん

VOICEVOX CORE 0.17.0・voicevox_vvm 0.16.4で生成した合成音声です。
音声素材を利用・再配布する場合は、以下の音声ライブラリ規約とクレジット条件を守り、再利用者にも同じ遵守を求めてください。

- https://voicevox.hiroshiba.jp/term/
- https://github.com/VOICEVOX/voicevox_vvm/blob/0.16.4/TERMS.txt
- https://zunko.jp/con_ongen_kiyaku.html

モデルやエンジンそのものは配布していません。生成設定と文言は `assets/voices/manifest.json`、再生成手順は `docs/voices.md` を参照してください。
