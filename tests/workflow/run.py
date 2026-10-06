# Offline UI acceptance; simulation and safety boundaries are documented in README.md.
import json, subprocess, tempfile, threading, time, re, sys, mimetypes
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect
from photo_geometry import assert_photo_contained
root = Path(__file__).resolve().parents[2]
source = Path(__file__).resolve().parent
base = Path(tempfile.mkdtemp(prefix='blackcat-workflow-artifacts-'))
count = 100
source_photo_count = count * 4  # Three garment photos and one real QR marker per item.
listing_photo_count = count * 3
print(json.dumps({'artifacts': str(base)}), flush=True)
built = subprocess.run(['node', str(source / 'bundle.cjs'), str(base)], cwd=root, capture_output=True, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
(base / 'bundle.log').write_text(built.stdout + built.stderr, encoding='utf-8')
if built.returncode:
    raise RuntimeError('Workflow bundle failed; inspect ' + str(base / 'bundle.log'))
run_started = time.monotonic()
bundle = (base / 'workflow.bundle.js').read_text(encoding='utf-8')
css = (root / 'node_modules/tailwindcss/preflight.css').read_text(encoding='utf-8') + '\n' + '\n'.join(((root / f'src/app/{name}.css').read_text(encoding='utf-8') for name in ['globals', 'depth']))
html = '<meta charset="utf-8"><style>' + css.replace('@import "tailwindcss";', '') + '</style><div id="root"></div><script>' + bundle.replace('</script', '<\\/script') + '</script>'
proof = {'noServer': True, 'externalRequests': [], 'browserErrors': [], 'syntheticPhotos': True, 'realQrIntake': True, 'backupHookSubstituted': True, 'simulatedRecognition': True, 'simulatedMarketplace': True, 'phases': [], 'timings': {}, 'beforeRestartPublishes': []}
with tempfile.TemporaryDirectory(prefix='blackcat-workflow-') as directory:
    folder = Path(directory)
    (folder / 'fixture-owner.json').write_text('{"fixture":true}')
    seq = 0
    lock = threading.Lock()
    proc = None
    close_sent = False
    log = (base / 'backend.log').open('w', encoding='utf-8')

    def start():
        global close_sent
        close_sent = False
        return subprocess.Popen(['node', str(source / 'backend.mjs'), str(folder)], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)

    def call(op, args={}):
        global seq, close_sent
        with lock:
            if op == 'close':
                close_sent = True
            seq += 1
            proc.stdin.write(json.dumps({'id': seq, 'op': op, 'args': args}) + '\n')
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError('Fixture backend stopped; inspect workflow-ui-backend.log')
            reply = json.loads(line)
            assert reply['id'] == seq
            return reply

    def data(op, args={}):
        reply = call(op, args)
        assert reply['ok'], reply
        return reply['data']

    def wait_engine():
        for _ in range(600):
            snapshot = data('snapshot')
            if not snapshot['engineActive']:
                return snapshot
            time.sleep(0.05)
        raise AssertionError('Fixture publishing engine did not finish')

    def restart():
        global proc
        data('close')
        proc.wait(timeout=15)
        proc = start()
    proc = start()
    try:
        started = time.monotonic()
        summary = data('seed', {'count': count})
        proof['timings']['import'] = time.monotonic() - started
        assert summary['itemsCreated'] == count
        assert data('snapshot')['photos'] == source_photo_count
        proof['import'] = summary
        proof['nativeIntake'] = data('intakeProof')
        assert proof['nativeIntake']['realQrDecodes'] == count and proof['nativeIntake']['markers'] == count
        assert proof['nativeIntake']['listingPhotos'] == listing_photo_count and proof['nativeIntake']['photos'] == source_photo_count
        assert proof['nativeIntake']['firstSku'] == '900001' and proof['nativeIntake']['lastSku'] == '900100'
        proof['phases'].append('400 camera files imported through actual helper and worker; 100 real QR markers grouped by EXIF despite reverse filenames; synthetic recognition applied after native intake')
        proof['reimport'] = data('reimport')
        assert proof['reimport']['itemsCreated'] == 0 and proof['reimport']['duplicatesSkipped'] == 4 and proof['reimport']['collisions'] == 0
        assert data('snapshot')['photos'] == source_photo_count
        proof['phases'].append('exact four-photo reimport detected without changing inventory or leaving incoming files')
        print(json.dumps({'phase': 'imported', 'items': count}), flush=True)
        with tempfile.TemporaryDirectory(prefix='blackcat-workflow-browser-') as profile, sync_playwright() as pw:
            browser = pw.chromium.launch_persistent_context(profile, headless=True, executable_path='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', viewport={'width': 1440, 'height': 1000})
            browser.add_init_script("localStorage.setItem('bca-sound-muted','1')")
            browser.expose_binding('workflowCall', lambda source, message: call(message['op'], message.get('args', {})))

            def route(r):
                url = urlsplit(r.request.url)
                if url.netloc == '127.0.0.1:42095' and (not url.path.startswith('/api/')):
                    r.fulfill(status=200, content_type='text/html', body=html)
                    return
                if url.netloc == '127.0.0.1:42095' and url.path in ['/api/photo', '/api/thumb']:
                    values = parse_qs(url.query)
                    file = Path(values.get('path', values.get('full', ['']))[0]).resolve()
                    if file.is_relative_to(folder.resolve()) and file.is_file():
                        r.fulfill(status=200, content_type=mimetypes.guess_type(file.name)[0] or 'image/jpeg', body=file.read_bytes())
                        return
                proof['externalRequests'].append(r.request.url)
                r.abort()
            browser.route('**/*', route)
            p = browser.new_page()
            p.on('pageerror', lambda e: proof['browserErrors'].append(str(e)))
            p.on('dialog', lambda d: d.accept())
            p.set_default_timeout(15000)

            def wait_checkpoints(expected, phase='reviewed', timeout=600):
                deadline = time.monotonic() + timeout
                last = -1
                while time.monotonic() < deadline:
                    observed = p.evaluate('phase=>window.readCheckpoints().then(rows=>rows.filter(row=>row.phase===phase).length)', phase)
                    if observed == expected:
                        return
                    if phase == 'approved' and observed // 10 != last:
                        last = observed // 10
                        print(json.dumps({'phase': 'batch-approving', 'items': observed}), flush=True)
                    p.wait_for_timeout(50)
                raise AssertionError('Checkpoint count did not reach ' + str(expected) + ' in phase ' + phase)
            p.goto('http://127.0.0.1:42095/ready')
            preview = p.get_by_role('region', name='Processed pieces awaiting review', exact=True)
            expect(preview).to_contain_text('100 waiting')
            expect(preview.get_by_role('link', name='Review piece', exact=True)).to_have_count(6)
            assert len(data('snapshot')['items']) == count
            proof['phases'].append('Complete100awaiting-review count with bounded six-item preview')
            p.goto('http://127.0.0.1:42095/review')
            started = time.monotonic()
            for index in range(1, count + 1):
                sku = str(900000 + index)
                expect(p.get_by_role('heading', name='Review · ' + sku, exact=True)).to_be_visible()
                action = p.get_by_role('button', name='Reviewed for batch & next', exact=True)
                expect(action).to_be_enabled()
                if index == 1:
                    package_note = p.get_by_role('note', name='Package estimates', exact=True)
                    expect(package_note).to_contain_text('Estimated dimensions:')
                    p.get_by_text('More details & listing copy', exact=True).click()
                    weight = p.get_by_role('spinbutton', name=re.compile('^Ship Weight'))
                    saved_weight = weight.input_value()
                    weight.fill('18')
                    expect(package_note).to_contain_text('Weight: 18 oz (may be estimated; measurement not recorded).')
                    weight.fill('')
                    expect(package_note).to_contain_text('Estimated weight: 6 oz (item type).')
                    weight.fill(saved_weight)
                    proof['phases'].append('Review package labels follow edits and distinguish fallback estimates from unverified saved values')
                    p.get_by_role('combobox', name=re.compile('^Brand')).fill('Nike')
                    p.get_by_role('button', name=re.compile('Rotate')).first.click()
                    rotated = p.get_by_role('button', name='Enlarge selected item photo', exact=True).locator('img')
                    expect(rotated).to_have_attribute('style', re.compile(r'rotate\(90deg\)'))
                    assert_photo_contained(rotated)
                p.get_by_role('combobox', name=re.compile('^Condition')).fill('Good')
                p.get_by_role('spinbutton', name=re.compile('^Price')).fill('25')
                if index == 10:
                    deadline = time.monotonic() + 15
                    while not p.evaluate("()=>window.readDrafts('review').then(rows=>rows.some(row=>row.changes.listedPrice===25))"):
                        assert time.monotonic() < deadline
                        p.wait_for_timeout(25)
                    p.reload()
                    expect(p.get_by_role('heading', name='Review · ' + sku, exact=True)).to_be_visible()
                    expect(p.get_by_role('spinbutton', name=re.compile('^Price'))).to_have_value('25')
                    proof['phases'].append('unfinished review draft restored after full browser reload')
                action.click()
                wait_checkpoints(index)
                if index % 10 == 0:
                    print(json.dumps({'phase': 'individually-reviewed', 'items': index}), flush=True)
                if index == 99:
                    p.get_by_role('button', name='Batch approval (99)', exact=True).click()
                    expect(p.get_by_role('button', name='Select first 99 eligible', exact=True)).to_be_enabled()
                    expect(p.get_by_role('checkbox', name='Select 900100', exact=True)).to_have_count(0)
                    p.get_by_role('button', name=re.compile('^Review queue')).click()
                    proof['phases'].append('unreviewed item excluded from batch approval')
            proof['timings']['individualReview'] = time.monotonic() - started
            expect(p.get_by_role('heading', name='Individual review is caught up', exact=True)).to_be_visible()
            restart()
            p.reload()
            expect(p.get_by_role('heading', name='Individual review is caught up', exact=True)).to_be_visible()
            proof['phases'].append('100 individual checkpoints survived backend and browser restart')
            p.get_by_role('button', name='Open batch approval', exact=True).click()
            p.get_by_role('button', name='Select first 100 eligible', exact=True).click()
            p.get_by_role('button', name='Review batch (100)', exact=True).click()
            dialog = p.get_by_role('dialog')
            expect(dialog.get_by_role('heading', name='Approve 100 reviewed items?', exact=True)).to_be_visible()
            started = time.monotonic()
            dialog.get_by_role('button', name='Approve 100 items', exact=True).click()
            wait_checkpoints(100, 'approved')
            proof['timings']['batchApproval'] = time.monotonic() - started
            prepared = data('verifyPrepared')
            assert prepared['items'] == count and prepared['files'] == listing_photo_count and (prepared['archivedOriginals'] == source_photo_count) and (prepared['firstRotation'] == 90) and (prepared['firstDimensions'] == [1200, 900]), prepared
            proof['prepared'] = prepared
            snapshot = data('snapshot')
            assert all((item['status'] == 'Ready' for item in snapshot['items']))
            assert snapshot['audit']['exports'] == count and snapshot['photos'] == source_photo_count
            proof['phases'].append('100 reviewed items approved with real Python photo exports')
            print(json.dumps({'phase': 'approved', 'items': 100}), flush=True)
            before_package_view = data('snapshot')['items']
            p.goto('http://127.0.0.1:42095/inventory/1')
            expect(p.get_by_role('note', name='Package estimates', exact=True)).to_contain_text('Estimated dimensions:')
            expect(p.get_by_role('note', name='Package estimates', exact=True)).to_contain_text('measurement not recorded')
            assert_photo_contained(p.get_by_alt_text('Photo 1 for 900001', exact=True))
            assert data('snapshot')['items'] == before_package_view
            data('behavior', {'hold': '900001:ebay'})
            p.goto('http://127.0.0.1:42095/ready')
            expect(p.get_by_role('note', name='Package estimates', exact=True)).to_have_count(count)
            expect(p.get_by_role('note', name='Package estimates', exact=True).first).to_contain_text('Estimated dimensions:')
            expect(p.get_by_role('note', name='Package estimates', exact=True).first).to_contain_text('measurement not recorded')
            proof['phases'].append('Editor and all100Ready queue rows show package provenance without changing saved inventory')
            proof['packageLayouts'] = []
            for width in [1440, 1024, 768, 390, 320]:
                p.set_viewport_size({'width': width, 'height': 1000})
                body_width = p.evaluate('document.documentElement.scrollWidth')
                assert body_width <= width, (width, body_width)
                p.screenshot(path=str(base / f'package-queue-{width}.png'))
                proof['packageLayouts'].append({'width': width, 'bodyWidth': body_width})
            p.set_viewport_size({'width': 1440, 'height': 1000})
            p.get_by_role('button', name='Select all ready', exact=True).click()
            p.get_by_role('button', name='Start selected', exact=True).click()
            p.wait_for_url('**/ready/activity')
            expect(p.get_by_role('button', name='Pause', exact=True)).to_be_enabled()
            for _ in range(200):
                if len(data('snapshot')['audit']['publishes']) == 1:
                    break
                p.wait_for_timeout(25)
            assert len(data('snapshot')['audit']['publishes']) == 1
            p.get_by_role('button', name='Pause', exact=True).click()
            expect(p.get_by_role('button', name='Resume', exact=True)).to_be_visible()
            data('behavior', {'release': True})
            snapshot = wait_engine()
            assert len(snapshot['audit']['publishes']) == 1
            proof['beforeRestartPublishes'] = snapshot['audit']['publishes']
            restart()
            p.reload()
            expect(p.get_by_role('button', name='Resume', exact=True)).to_be_visible()
            p.get_by_role('button', name='Resume', exact=True).click()
            p.wait_for_function("window.workflowReplies.some(r=>r.body?.action==='resume'&&r.ok===true)")
            snapshot = wait_engine()
            assert sum((job['status'] == 'published' for job in snapshot['jobs'])) == 198
            assert sum((job['status'] == 'requires_review' for job in snapshot['jobs'])) == 2
            proof['phases'].append('pause/resume survived restart; 198 target publications completed with two isolated failures')
            p.goto('http://127.0.0.1:42095/ready/recovery')
            known = p.locator('article').filter(has_text='#900005')
            unknown = p.locator('article').filter(has_text='#900006')
            expect(known.get_by_role('button', name='Retry this listing', exact=True)).to_be_enabled()
            expect(unknown.get_by_role('button', name='Retry this listing', exact=True)).to_have_count(0)
            data('behavior', {'failKnown': False})
            known.get_by_role('button', name='Retry this listing', exact=True).click()
            p.wait_for_function("window.workflowReplies.some(r=>r.body?.action==='retry'&&r.ok===true)")
            snapshot = wait_engine()
            assert sum((job['status'] == 'published' for job in snapshot['jobs'])) == 199
            assert sum((job['status'] == 'requires_review' for job in snapshot['jobs'])) == 1
            proof['phases'].append('safe retry published only the failed Depop target; unknown eBay outcome stayed blocked')
            p.goto('http://127.0.0.1:42095/ready')
            p.get_by_role('checkbox', name='eBay', exact=True).uncheck()
            p.get_by_role('checkbox', name='Depop', exact=True).uncheck()
            p.get_by_role('checkbox', name='Poshmark', exact=True).check()
            p.get_by_role('checkbox', name='Select 900001', exact=True).check()
            p.get_by_role('button', name='Start selected', exact=True).click()
            p.wait_for_url('**/ready/activity')
            snapshot = wait_engine()
            assert any((row['marketplace'] == 'poshmark' and row['status'] == 'published' for row in snapshot['items'][0]['marketplaceListings']))
            receipt = data('sale', {'itemId': 1, 'marketplace': 'poshmark'})
            assert receipt['outcome'] == 'recorded' and len(receipt['pending']) == 2
            data('behavior', {'unknownRemoval': True})
            p.goto('http://127.0.0.1:42095/ready/activity')
            print(json.dumps({'phase': 'sale-recorded', 'pending': 2}), flush=True)
            region = p.get_by_role('region', name='Sale removals', exact=True)
            expect(region.locator('li')).to_have_count(2)
            region.get_by_role('button', name='Process queued removals', exact=True).click()
            expect(region.get_by_text('Availability needs verification', exact=False)).to_have_count(2)
            snapshot = data('snapshot')
            sold = snapshot['items'][0]
            assert sold['status'] == 'Sold' and all((row['status'] == 'delist_unknown' for row in sold['marketplaceListings'] if row['marketplace'] != 'poshmark'))
            data('behavior', {'unknownRemoval': False})
            region.get_by_role('button', name='Process queued removals', exact=True).click()
            expect(region.get_by_text('No pending removals recorded.', exact=True)).to_be_visible()
            proof['phases'].append('Poshmark sale queued both other platforms; uncertain removal stayed open until verified')
            p.goto('http://127.0.0.1:42095/sales/insights')
            cost = p.get_by_role('textbox', name='Cost for 900001', exact=True)
            expect(cost).to_be_enabled()
            cost.fill('5')
            cost.press('Enter')
            expect(p.get_by_text('900001 cost saved', exact=True)).to_be_visible()
            expect(p.get_by_text(re.compile('\\$19\\.00')).first).to_be_visible()
            report = data('request', {'url': '/api/earnings?days=all'})
            assert report['totals']['count'] == 1 and report['totals']['revenue'] == 30 and (report['totals']['netProfit'] == 19), report['totals']
            assert report['estimates']['fees'] and report['soldItems'][0]['costMissing'] == False
            proof['earnings'] = {key: report['totals'][key] for key in ['count', 'revenue', 'netProfit', 'cogs']}
            proof['phases'].append('Insights saved a real cost and reported fixture revenue/profit with estimates labeled')
            p.screenshot(path=str(base / 'insights.png'))
            p.goto('http://127.0.0.1:42095/sales')
            p.get_by_role('button', name='Mark shipped', exact=True).click()
            expect(p.get_by_role('button', name='Undo shipped', exact=True)).to_be_enabled()
            snapshot = data('snapshot')
            before = snapshot['items'][0]
            assert before['shippedAt']
            replay = data('sale', {'itemId': 1, 'marketplace': 'poshmark'})
            assert replay['outcome'] == 'already_recorded'
            after = data('snapshot')['items'][0]
            assert after['shippedAt'] == before['shippedAt'] and after['dateSold'] == before['dateSold'] and (after['salePrice'] == 30) and (after['itemCost'] == 5)
            assert data('request', {'url': '/api/ship-queue'})['count'] == 0
            proof['phases'].append('shipping completion and duplicate sale observation preserved sale/cost history')
            p.goto('http://127.0.0.1:42095/inventory')
            p.get_by_role('textbox', name='Search inventory', exact=True).fill('900001')
            expect(p.get_by_role('article')).to_have_count(1)
            expect(p.get_by_role('article').get_by_text('Sold', exact=True)).to_be_visible()
            proof['phases'].append('inventory search found the sold item with its current marketplace states')
            proof['layouts'] = []
            for width in [1440, 1024, 768, 390, 320]:
                p.set_viewport_size({'width': width, 'height': 1000})
                bounds = p.evaluate('()=>({width:innerWidth,bodyWidth:document.documentElement.scrollWidth})')
                assert bounds['width'] == bounds['bodyWidth']
                assert_photo_contained(p.get_by_role('article').locator('img'))
                proof['layouts'].append(bounds)
            p.screenshot(path=str(base / 'sold-320.png'))
            proof['phases'].append('rotated photos fit Review, Editor and five-width Inventory frames')
            snapshot = data('snapshot')
            calls = proof['beforeRestartPublishes'] + snapshot['audit']['publishes']
            assert sum((row['sku'] == '900001' and row['marketplace'] == 'ebay' for row in calls)) == 1
            assert sum((row['sku'] == '900005' and row['marketplace'] == 'depop' for row in calls)) == 2
            assert sum((row['sku'] == '900006' and row['marketplace'] == 'ebay' for row in calls)) == 1
            print(json.dumps({'phase': 'final-check', 'photos': snapshot['photos'], 'pendingOriginals': snapshot['pendingOriginals'], 'unexpected': snapshot['audit']['unexpected'], 'realMarketplaceCalls': snapshot['audit']['realMarketplaceCalls'], 'items': len(snapshot['items']), 'soldListingStates': [(row['marketplace'], row['status']) for row in snapshot['items'][0]['marketplaceListings']]}), flush=True)
            assert snapshot['photos'] == source_photo_count and snapshot['pendingOriginals'] == 0 and (not snapshot['audit']['unexpected']) and (snapshot['audit']['realMarketplaceCalls'] == 0)
            assert len(snapshot['items']) == 100
            assert all((row['status'] in ['sold', 'ended'] for row in snapshot['items'][0]['marketplaceListings']))
            proof['retentionAfterSale'] = data('verifyPrepared')
            assert proof['retentionAfterSale']['archivedOriginals'] == source_photo_count and proof['retentionAfterSale']['files'] == listing_photo_count
            proof['sale'] = receipt
            proof['final'] = {'items': count, 'photos': source_photo_count, 'jobs': len(snapshot['jobs']), 'publishedJobs': sum((job['status'] == 'published' for job in snapshot['jobs'])), 'unknownJobs': sum((job['status'] == 'requires_review' for job in snapshot['jobs'])), 'marketplaceCallsAreSimulated': True, 'realMarketplaceCalls': 0, 'remainingInventoryStatus': {state: sum((item['status'] == state for item in snapshot['items'])) for state in ['Ready', 'Sold']}}
            browser.close()
        assert not proof['externalRequests'] and (not proof['browserErrors']), proof
        proof['timings']['total'] = time.monotonic() - run_started
        (base / 'proof.json').write_text(json.dumps(proof, indent=2))
        print(json.dumps({k: v for k, v in proof.items() if k != 'snapshot'}), flush=True)
    finally:
        if proc and proc.poll() is None:
            try:
                if not close_sent:
                    data('close')
                proc.wait(timeout=15)
            except Exception:
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=15)
        log.close()
