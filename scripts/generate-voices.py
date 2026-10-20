#!/usr/bin/env python3
"""Offline authoring only. Requires voicevox_core==0.17.0 and ffmpeg; never shipped as a runtime service."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
# Derive full sentences from the existing subtitles; short reactions must finish
# inside their existing 1.6 s / 0.9 s windows, without changing the game timers.
characters = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    'import { CHARACTERS } from "./characters.mjs"; console.log(JSON.stringify(CHARACTERS));'], cwd=root))
profiles = {
    'rabbit': {'credit': 'VOICEVOX:四国めたん', 'style': 0, 'speed': 1.08, 'pitch': 0.035},
    'bear': {'credit': 'VOICEVOX:ずんだもん', 'style': 1, 'speed': 0.96, 'pitch': -0.045},
    'cat': {'credit': 'VOICEVOX:ずんだもん', 'style': 3, 'speed': 1.10, 'pitch': 0.045},
}
onnx = next(args.runtime.rglob('libvoicevox_onnxruntime.so.1.17.3'))
dictionary = next(args.runtime.rglob('open_jtalk_dic_utf_8-1.11'))
synth = Synthesizer(Onnxruntime.load_once(filename=str(onnx)), OpenJtalk(dictionary), acceleration_mode='CPU', cpu_num_threads=2)
with VoiceModelFile.open(args.runtime / '0.vvm') as model:
    synth.load_voice_model(model)
manifest = {'engine': 'VOICEVOX CORE 0.17.0', 'model': 'voicevox_vvm 0.16.4 / 0.vvm',
            'modelSha256': hashlib.sha256((args.runtime / '0.vvm').read_bytes()).hexdigest(), 'clips': []}
for animal, profile in profiles.items():
    lines = {k: characters[animal][k] for k in ['greeting', 'pet', 'ready', 'found', 'dark']}
    lines.update(peek='今見てた？', returned='いた！', night='もう夜だから眠いよ。また明日ね。',
                 missing='いなくなっちゃった。お顔を見せてね。', seeking='どこに隠れたかな？探してね！')
    target = root / 'assets' / 'voices' / animal
    target.mkdir(parents=True, exist_ok=True)
    for cue, text in lines.items():
        query = synth.create_audio_query(text.replace('〜', 'ー'), profile['style'])
        query.speed_scale = 1.35 if cue == 'returned' else 1.18 if cue == 'peek' else profile['speed']
        query.pitch_scale = profile['pitch']
        query.intonation_scale = 1.05
        query.pre_phoneme_length = 0.03
        query.post_phoneme_length = 0.04
        filename = 'noticed' if cue == 'peek' else cue
        output = target / f'{filename}.mp3'
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / 'voice.wav'
            wav.write_bytes(synth.synthesis(query, profile['style']))
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-af',
                            'loudnorm=I=-20:TP=-3:LRA=7', '-ar', '24000', '-ac', '1', '-b:a', '64k',
                            '-map_metadata', '-1', str(output)], check=True)
        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(output)]))
        manifest['clips'].append({'character': animal, 'cue': cue, 'text': text, **profile,
            'speed': query.speed_scale, 'file': str(output.relative_to(root)), 'duration': duration,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
        print(animal, cue, duration, flush=True)
(root / 'assets/voices/manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
