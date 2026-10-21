#!/usr/bin/env python3
"""Authoring-only VOICEVOX ENGINE synthesis; output is fixed MP3 assets for offline use."""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CHARACTERS = {
    "rabbit": {"speaker": 0, "credit": "VOICEVOX:四国めたん", "pitch": .035, "speed": 1.12},
    "bear": {"speaker": 1, "credit": "VOICEVOX:ずんだもん", "pitch": -.045, "speed": 1.04},
    "cat": {"speaker": 3, "credit": "VOICEVOX:ずんだもん", "pitch": .045, "speed": 1.15},
}
MILESTONES = list(range(60, 10, -5)) + list(range(10, 0, -1))
WORDS = {10: "じゅー！", 9: "きゅー！", 8: "はーち！", 7: "なーな！",
         6: "ろーく！", 5: "ごー！", 4: "よーん！", 3: "さーん！",
         2: "にー！", 1: "いーち！"}
CHEERS = ["そのちょうし！", "いいかんじ！", "もうちょっと！"]

def request(base, path, body=None, params=None):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urlencode(params)
    headers = {"Content-Type": "application/json"} if body is not None else {}
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else b""
    with urlopen(Request(url, data=data, headers=headers, method="POST"), timeout=80) as r:
        return r.read()

def duration(path):
    return float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)]))

def encode(wav, mp3, speedup=1.0):
    filters = ([] if speedup <= 1.001 else [f"atempo={speedup:.4f}"])
    filters.append("loudnorm=I=-20:TP=-3:LRA=7")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(wav), "-af", ",".join(filters), "-ar", "24000", "-ac", "1",
        "-b:a", "64k", "-map_metadata", "-1", str(mp3)], check=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:50021")
    args = parser.parse_args()
    with urlopen(args.endpoint.rstrip("/") + "/version", timeout=30) as r:
        version = r.read().decode()
    manifest = {"schemaVersion": 1, "engine": "VOICEVOX ENGINE", "engineVersion": version,
        "dockerImage": os.environ.get("VOICEVOX_IMAGE", "voicevox/voicevox_engine:cpu-latest"),
        "clips": []}
    for animal, profile in CHARACTERS.items():
        dest = ROOT / "assets/voices/countdown" / animal
        dest.mkdir(parents=True, exist_ok=True)
        for number in MILESTONES:
            words = WORDS.get(number)
            text = words if words else f"あと{number}秒！{CHEERS[(number // 5) % len(CHEERS)]}"
            query = json.loads(request(args.endpoint, "/audio_query",
                params={"text": text, "speaker": profile["speaker"]}))
            query["speedScale"] = 1.52 if number <= 10 else profile["speed"]
            query["pitchScale"] = profile["pitch"]
            query["intonationScale"] = 1.05
            query["prePhonemeLength"] = .02
            query["postPhonemeLength"] = .02
            wav_bytes = request(args.endpoint, "/synthesis", query, {"speaker": profile["speaker"]})
            output = dest / f"{number}.mp3"
            with tempfile.TemporaryDirectory() as directory:
                wav = Path(directory) / "voice.wav"
                wav.write_bytes(wav_bytes)
                encode(wav, output)
                seconds = duration(output)
                # Short spoken numerals must fit inside the next 1-second boundary.
                if number <= 10 and seconds > .94:
                    encode(wav, output, min(4.0, seconds / .89))
                    seconds = duration(output)
            if not .15 < seconds < (1.05 if number <= 10 else 4.5):
                raise ValueError(f"Unexpected clip duration {animal}/{number}: {seconds:.3f}s")
            relative = output.relative_to(ROOT).as_posix()
            manifest["clips"].append({"character": animal, "cue": f"count-{number}",
                "remainingSeconds": number, "text": text, "credit": profile["credit"],
                "speaker": profile["speaker"], "pitch": profile["pitch"],
                "speed": query["speedScale"], "file": relative,
                "duration": seconds, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()})
            print(animal, number, text, seconds, flush=True)
    target = ROOT / "assets/voices/countdown-manifest.json"
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
