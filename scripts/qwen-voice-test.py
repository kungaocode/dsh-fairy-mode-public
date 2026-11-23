"""Local Qwen voice audition: ordinary enrollment + Token Plan realtime.

Reads the two credentials and workspace URL from ignored api_qwen.txt.
Audio, voice IDs and reports stay under ignored local-artifacts/fairy-voice.
Requires requests and websocket-client (or local-artifacts/python-libs).
"""
from pathlib import Path
import argparse
import array
import base64
import hashlib
import json
import math
import os
import re
import sys
import time
import uuid
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'local-artifacts' / 'python-libs'))
import requests
import websocket

MODEL = 'qwen-audio-3.0-realtime-plus'
FOLDER = ROOT / 'local-artifacts' / 'fairy-voice'
TEXT = '主人，我在。查询目标已确认，我会为您整理线索，并保留每一条情报的来源。'


def load_config():
    document = (ROOT / 'api_qwen.txt').read_text(encoding='utf-8-sig')
    keys = list(dict.fromkeys(re.findall(r'sk-[A-Za-z0-9_.-]+', document)))
    keys = [key for key in keys if len(key) > 25]
    plan = [key for key in keys if key.startswith('sk-sp-')]
    ordinary = [key for key in keys if not key.startswith('sk-sp-')]
    hosts = list(dict.fromkeys(re.findall(
        r'https://(ws-[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com)', document)))
    if len(plan) != 1 or len(ordinary) != 1 or len(hosts) != 1:
        raise RuntimeError('Need one Token Plan key, one ordinary key, and one Beijing workspace URL in api_qwen.txt')
    return {'plan_key': plan[0], 'ordinary_key': ordinary[0], 'ordinary_host': hosts[0]}


def safe_error(error, config):
    message = str(error)
    for field in ('plan_key', 'ordinary_key'):
        message = message.replace(config[field], '[REDACTED]')
    return message[:1000]


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def enrollment_call(config, payload):
    with requests.Session() as session:
        session.trust_env = False
        response = session.post(
            'https://' + config['ordinary_host'] + '/api/v1/services/audio/tts/customization',
            headers={'Authorization': 'Bearer ' + config['ordinary_key']},
            json={'model': 'voice-enrollment', 'input': payload}, timeout=(8, 35))
    try:
        data = response.json()
    except ValueError:
        raise RuntimeError('Enrollment returned non-JSON; HTTP ' + str(response.status_code))
    if not response.ok or data.get('code'):
        raise RuntimeError(json.dumps({'http_status': response.status_code,
            'code': data.get('code'), 'message': data.get('message')}, ensure_ascii=False))
    return data.get('output', {})


def enroll(config, label, *, sample=None, state_path=None, prefix=None):
    sample = sample or FOLDER / ('fairy-reference-' + label + '.wav')
    pcm = sample.read_bytes()
    digest = hashlib.sha256(pcm).hexdigest()
    path = state_path or FOLDER / ('realtime-voice-' + label + '.json')
    identity = {'target_model': MODEL, 'reference_sha256': digest,
                'workspace_host': config['ordinary_host']}
    if path.exists():
        state = json.loads(path.read_text(encoding='utf-8'))
        if any(state.get(key) != value for key, value in identity.items()):
            raise RuntimeError('Saved voice settings differ; refusing duplicate enrollment')
    else:
        with wave.open(str(sample), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
        result = enrollment_call(config, {'action': 'create_voice', 'target_model': MODEL,
            'prefix': prefix or 'fairy' + label, 'audio': 'data:audio/wav;base64,' + base64.b64encode(pcm).decode('ascii'),
            'language_hints': ['zh'], 'max_prompt_audio_length': min(30.0, duration),
            'enable_preprocess': True})
        voice = result.get('voice_id')
        if not voice:
            raise RuntimeError('Enrollment returned no voice ID')
        state = dict(identity, voice_id=voice, reference=str(sample), status='created')
        save_json(path, state)  # Save immediately so reruns cannot create duplicates.
    print(json.dumps({'stage': 'voice-created', 'label': label, 'voice_id': state['voice_id']}, ensure_ascii=False), flush=True)
    for _ in range(20):
        result = enrollment_call(config, {'action': 'query_voice', 'voice_id': state['voice_id']})
        status = result.get('status')
        state['status'] = status
        save_json(path, state)
        if status == 'OK':
            return state['voice_id']
        if status not in ('DEPLOYING', 'CREATING', 'PROCESSING'):
            raise RuntimeError('Voice status=' + str(status))
        time.sleep(1)
    raise RuntimeError('Voice is processing; rerun to reuse the saved ID')


def audition(config, voice, name, route='plan', save_audio=False, folder=FOLDER, *, verify_transcript=False):
    host = 'token-plan.cn-beijing.maas.aliyuncs.com' if route == 'plan' else config['ordinary_host']
    key = config['plan_key'] if route == 'plan' else config['ordinary_key']
    url = 'wss://' + host + '/api-ws/v1/realtime?model=' + MODEL
    started = time.monotonic()
    first_audio = None
    chunks, transcript, events = [], [], []
    connection = None
    report = {'ok': False, 'model': MODEL, 'voice': voice, 'route': route, 'requested_text': TEXT}
    def send(event, **payload):
        connection.send(json.dumps(dict(type=event, event_id=uuid.uuid4().hex, **payload), ensure_ascii=False))
    try:
        connection = websocket.create_connection(url, header={'Authorization': 'Bearer ' + key}, timeout=30)
        configured = requested = finished = False
        while time.monotonic() - started < 90:
            raw = connection.recv()
            if not raw:
                raise RuntimeError('Connection closed before completion')
            message = json.loads(raw)
            event = message.get('type', '')
            if event not in events:
                events.append(event)
            if event == 'error':
                raise RuntimeError(json.dumps(message.get('error', {}), ensure_ascii=False))
            if event == 'session.created' and not configured:
                send('session.update', session={'modalities': ['audio', 'text'], 'voice': voice,
                    'input_audio_format': 'pcm', 'output_audio_format': 'pcm', 'turn_detection': None,
                    'instructions': '你是语音试听助手。只逐字朗读用户给出的中文，不添加解释、前言或其他内容。语气冷静、清晰、略带机械感。'})
                configured = True
            elif event == 'session.updated' and not requested:
                send('conversation.item.create', item={'type': 'message', 'role': 'user',
                    'content': [{'type': 'input_text', 'text': TEXT}]})
                send('response.create', response={'modalities': ['audio', 'text']})
                requested = True
            elif event == 'response.audio.delta':
                chunk = base64.b64decode(message['delta'], validate=True)
                if chunk:
                    first_audio = first_audio or time.monotonic()
                    chunks.append(chunk)
            elif event == 'response.audio_transcript.delta':
                transcript.append(message.get('delta', ''))
            elif event == 'response.done':
                response = message.get('response', {})
                if response.get('status') != 'completed':
                    raise RuntimeError('Incomplete response: ' + json.dumps(response.get('status_details', {}), ensure_ascii=False))
                finished = True
                break
        pcm = b''.join(chunks)
        if not finished or len(pcm) < 4800 or len(pcm) % 2:
            raise RuntimeError('No complete PCM audio returned')
        values = array.array('h', pcm)
        if sys.byteorder != 'little':
            values.byteswap()
        rms = math.sqrt(sum(value * value for value in values) / len(values))
        if rms == 0:
            raise RuntimeError('Audio contains only silence')
        if verify_transcript and ''.join(''.join(transcript).split()) != ''.join(TEXT.split()):
            raise RuntimeError('回传的朗读文字与试听稿不一致')
        destination = folder / (name + '.wav') if save_audio else None
        if destination:
            with wave.open(str(destination), 'wb') as audio:
                audio.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                audio.writeframes(pcm)
        report.update(ok=True, audio=str(destination) if destination else None, transcript=''.join(transcript),
            duration_seconds=round(len(pcm) / 48000, 3), rms=round(rms, 1),
            first_audio_seconds=round(first_audio - started, 3))
    except Exception as error:
        report['error'] = safe_error(error, config)
    finally:
        if connection:
            connection.close()
    report.update(events=events, elapsed_seconds=round(time.monotonic() - started, 3))
    save_json(folder / (name + '-result.json'), report)
    print(json.dumps({key: report[key] for key in ('ok', 'duration_seconds', 'first_audio_seconds', 'error')
                      if key in report}, ensure_ascii=False), flush=True)
    return report


def register_packs(config, source, desktop_path):
    desktop = json.loads(desktop_path.read_text(encoding='utf-8-sig'))
    if desktop.get('model', MODEL) != MODEL or desktop.get('apiKey') != config['plan_key']:
        raise ValueError('桌面朗读配置使用不同的 Key 或模型，无法从此脚本复用试听结果')
    voices = {entry['id']: entry for entry in desktop.get('voices', [])}
    success = True
    for ident, label in (('citlali', '茜特菈莉'), ('voyanisha', '沃雅妮莎'), ('cyrene', '昔涟')):
        folder = source / label
        print(label, flush=True)
        try:
            voice = enroll(config, ident, sample=folder / 'reference.wav',
                           state_path=folder / 'enrollment.json', prefix=ident)
            result = audition(config, voice, 'audition', save_audio=True, folder=folder, verify_transcript=True)
            if result['ok']:
                voices[ident] = {'id': ident, 'label': label, 'voice': voice}
            else:
                success = False
        except Exception as error:
            print(safe_error(error, config), flush=True)
            success = False
    if voices:
        desktop['voices'] = list(voices.values())
        save_json(desktop_path, desktop)
    return 0 if success else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['probe', 'baseline', 'compare', 'register-packs'])
    parser.add_argument('--save-audio', action='store_true', help='Explicitly export WAV auditions; disabled by default')
    parser.add_argument('--packs-dir', type=Path)
    parser.add_argument('--desktop-config', type=Path, default=Path(os.environ.get('FAIRY_QWEN_CONFIG') or
        Path(os.environ.get('DSH_HOME') or Path.home() / '.dsh') / 'fairy-qwen.json'))
    args = parser.parse_args()
    if args.action == 'register-packs' and args.packs_dir is None:
        parser.error('register-packs requires --packs-dir')
    config = load_config()
    if args.action == 'register-packs':
        return register_packs(config, args.packs_dir, args.desktop_config)
    FOLDER.mkdir(parents=True, exist_ok=True)
    if args.action == 'probe':
        try:
            result = enrollment_call(config, {'action': 'list_voice', 'page_index': 0, 'page_size': 10})
            print(json.dumps({'ok': True, 'stage': 'ordinary-enrollment-probe',
                'voice_count': len(result.get('voice_list', []))}), flush=True)
            return 0
        except Exception as error:
            print(json.dumps({'ok': False, 'error': safe_error(error, config)}, ensure_ascii=False), flush=True)
            return 1
    if args.action == 'baseline':
        return 0 if audition(config, 'longanlingxin', 'realtime-system-baseline', save_audio=args.save_audio)['ok'] else 1
    success = True
    for label in ('A', 'B'):
        try:
            voice = enroll(config, label)
            result = audition(config, voice, 'realtime-fairy-' + label + '-tokenplan', save_audio=args.save_audio)
            if not result['ok']:
                # One short ordinary-route call distinguishes sharing restrictions
                # from enrollment/voice errors. Reports retain the actual route.
                audition(config, voice, 'realtime-fairy-' + label + '-ordinary', route='ordinary', save_audio=args.save_audio)
            success = success and result['ok']
        except Exception as error:
            success = False
            result = {'ok': False, 'label': label, 'stage': 'enrollment', 'error': safe_error(error, config)}
            save_json(FOLDER / ('realtime-enrollment-' + label + '-result.json'), result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
