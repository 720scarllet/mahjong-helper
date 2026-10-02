"""JSONL adapter for the bundled local policy. No game operations are sent."""
import argparse
import contextlib
import json
import pathlib
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
args = parser.parse_args()
sys.path.insert(0, args.model_dir)

with contextlib.redirect_stdout(sys.stderr):
    import torch
    torch.set_num_threads(2)
    import _libriichi_loader
    _libriichi_loader.load()
    import model
    # Local-only, regardless of upstream legacy settings files.
    model.ot_settings.update(online=False, api_key='')
    checkpoint = torch.load(pathlib.Path(args.model_dir) / 'mortal.pth', map_location='cpu', weights_only=True)
    config = checkpoint['config']
    version = config['control']['version']
    brain = model.Brain(version=version, conv_channels=config['resnet']['conv_channels'], num_blocks=config['resnet']['num_blocks'])
    dqn = model.DQN(version=version)
    brain.load_state_dict(checkpoint['mortal'])
    dqn.load_state_dict(checkpoint['current_dqn'])
    model._engine = model.MortalEngine(brain, dqn, is_oracle=False, version=version, device=torch.device('cpu'), enable_quick_eval=False, enable_rule_based_agari_guard=True)

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        if req.get('probe'):
            print(json.dumps({'id': req['id'], 'ready': True}), flush=True)
            continue
        started = time.perf_counter()
        events = req['events']
        if not events or events[0]['type'] != 'start_game':
            raise ValueError('Missing start_game')
        with contextlib.redirect_stdout(sys.stderr):
            bot = model.make_speculator(req['seat'])
            reaction = None
            for i, event in enumerate(events[1:], 1):
                reaction = bot.react(json.dumps(event), can_act=i == len(events)-1)
            action = json.loads(reaction) if reaction else {'type': 'none'}
            if action['type'] == 'reach':
                discard = bot.react(json.dumps({'type': 'reach', 'actor': req['seat']}), can_act=True)
                next_action = json.loads(discard) if discard else {}
                if next_action.get('type') != 'dahai':
                    raise ValueError('Riichi discard unavailable')
                action['pai'] = next_action['pai']
        out = {'id': req['id'], 'advice': action, 'elapsedMs': round((time.perf_counter()-started)*1000)}
    except Exception as error:
        out = {'id': req.get('id', 0), 'error': str(error)}
    try:
        print(json.dumps(out, ensure_ascii=True, allow_nan=False), flush=True)
    except ValueError:
        print(json.dumps({'id': req.get('id', 0), 'error': 'Non-finite model output'}), flush=True)
