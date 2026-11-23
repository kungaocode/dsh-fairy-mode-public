"""Extract up to two Bailian-compatible speech samples per local voice pack."""

import argparse
import json
import re
import subprocess
import wave
from pathlib import Path

from imageio_ffmpeg import get_ffmpeg_exe


PACKS = ('茜特菈莉', '沃雅妮莎', '昔涟')
SILENCE = re.compile(r'silence_(start|end): (\d+(?:\.\d+)?)')


def run_ffmpeg(*args):
    return subprocess.run([get_ffmpeg_exe(), '-hide_banner', '-nostdin', *args],
                          check=True, capture_output=True, encoding='utf-8', errors='replace')


def candidates(source):
    report = run_ffmpeg('-i', str(source), '-vn', '-af',
                        'aformat=channel_layouts=mono,silencedetect=noise=-36dB:d=0.45',
                        '-f', 'null', '-').stderr
    events = [(kind, float(at)) for kind, at in SILENCE.findall(report)]
    # Keep full phrases by cutting in the adjacent pauses.
    speech = [(left[1], right[1]) for left, right in zip(events, events[1:])
              if left[0] == 'end' and right[0] == 'start']
    ranked = []
    for index, (start, _) in enumerate(speech):
        spoken, longest, last_end = 0, 0, start
        for left, right in speech[index:]:
            if right - start > 19.6 or left - last_end > 1.8:
                break
            spoken += right - left
            longest = max(longest, right - left)
            last_end = right
            duration = right - start
            if duration >= 10 and longest >= 5 and spoken / duration >= 0.65:
                score = spoken / duration + min(longest, 10) * 0.025 - abs(duration - 16) * 0.015
                ranked.append((score, max(0, start - 0.12), right + 0.15))
    return sorted(ranked, reverse=True)


def prepare(source, directory, label):
    chosen = []
    for _, start, end in candidates(source):
        if all(end <= left or start >= right for left, right in chosen):
            chosen.append((start, end))
        if len(chosen) == 2:
            break
    if not chosen:
        raise ValueError(f'{label}没有找到足够长的连续语音')
    directory.mkdir(exist_ok=True)
    clips = []
    for name, (start, end) in zip(('reference.wav', 'alternate.wav'), chosen):
        destination = directory / name
        run_ffmpeg('-y', '-ss', f'{start:.3f}', '-i', str(source), '-t', f'{end - start:.3f}',
                   '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(destination))
        with wave.open(str(destination), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
        clips.append({'file': name, 'source_start_seconds': round(start, 3),
                      'duration_seconds': round(duration, 3)})
    (directory / 'corpus.json').write_text(json.dumps({'label': label, 'source': source.name,
        'sample_rate': 24000, 'channels': 1, 'bits_per_sample': 16, 'clips': clips},
        indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(label, ', '.join(f"{clip['file']} {clip['duration_seconds']:.2f}s" for clip in clips), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', type=Path)
    args = parser.parse_args()
    for label in PACKS:
        prepare(args.source_dir / f'{label}.m4a', args.source_dir / label, label)


if __name__ == '__main__':
    main()
