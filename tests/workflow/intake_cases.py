"""Real 50-item intake: corrupt input, cooperative cancellation, restart and missing QR."""
import json
import subprocess
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = Path(__file__).resolve().parent
artifacts = Path(tempfile.mkdtemp(prefix='blackcat-intake-artifacts-'))
print(json.dumps({'artifacts': str(artifacts)}), flush=True)
proof = {'noServer': True, 'syntheticPhotos': True, 'realNativeIntake': True,
         'recognitionDisabled': True, 'backupHookSubstituted': True, 'phases': {}}
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix='blackcat-workflow-') as directory:
    folder = Path(directory)
    (folder / 'fixture-owner.json').write_text('{"fixture":true}', encoding='utf-8')
    sequence = 0
    proc = None
    with (artifacts / 'backend.log').open('w', encoding='utf-8') as log:
        def start():
            return subprocess.Popen(['node', str(source / 'backend.mjs'), str(folder)], cwd=root,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                    text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)

        def call(op, args=None):
            global sequence
            sequence += 1
            proc.stdin.write(json.dumps({'id': sequence, 'op': op, 'args': args or {}}) + '\n')
            proc.stdin.flush()
            reply = json.loads(proc.stdout.readline())
            assert reply['id'] == sequence
            assert reply['ok'], reply
            return reply['data']

        def close():
            global proc
            if proc is None:
                return
            if proc.poll() is None:
                call('close')
            proc.wait(timeout=30)
            assert proc.returncode == 0
            proc.stdin.close()
            proc.stdout.close()
            proc = None

        proc = start()
        try:
            for stage in ['corrupt', 'cancel']:
                proof['phases'][stage] = call('intake-case', {'stage': stage})
                print(json.dumps({'phase': stage, 'result': proof['phases'][stage]}), flush=True)
            close()
            proc = start()
            proof['backendRestarted'] = True
            proof['phases']['resume'] = call('intake-case', {'stage': 'resume'})
            final = call('snapshot')
            assert not final['jobs'] and not final['audit']['publishes'] and not final['audit']['removals']
            assert final['audit']['realMarketplaceCalls'] == 0
            proof['marketplaceCalls'] = 0
            proof['phases']['resume']['inventoryCount'] = len(final['items'])
            proof['durationSeconds'] = round(time.monotonic() - started, 3)
            (artifacts / 'proof.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
            print(json.dumps({'passed': True, 'proof': str(artifacts / 'proof.json')}), flush=True)
        finally:
            close()
