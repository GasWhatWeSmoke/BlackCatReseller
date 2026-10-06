"""Actual appearance controls with local storage and a controlled local clock; no app server."""
import json, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
base = Path(tempfile.mkdtemp(prefix='blackcat-daily-theme-'))
print(str(base), flush=True)
with (base / 'bundle.log').open('w') as out:
    subprocess.run(['node', str(root / 'tests/workflow/bundle.cjs'), str(base)], cwd=root,
                   stdout=out, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
css = (root / 'node_modules/tailwindcss/preflight.css').read_text() + '\n' + '\n'.join(
    (root / 'src/app' / name).read_text(encoding='utf-8') for name in ['globals.css', 'depth.css']).replace('@import "tailwindcss";', '')
html = '<meta charset="utf-8"><style>' + css + '</style><div id="root"></div><script>' + (
    base / 'workflow.bundle.js').read_text(encoding='utf-8').replace('</script', '<\\/script') + '</script>'
errors, external, phases = [], [], []
origin = 'http://127.0.0.1:42096'

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
    context = browser.new_context(timezone_id='America/New_York', reduced_motion='reduce', viewport={'width':1320, 'height':1000})
    context.expose_binding('workflowCall', lambda source, message: {'ok':True, 'data':{'count':2}})
    def route(r):
        if r.request.resource_type == 'document' and r.request.url == origin + '/settings':
            r.fulfill(body=html, content_type='text/html')
        else:
            external.append(r.request.url); r.abort()
    context.route('**/*', route)
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time='2026-10-02T12:00:00-04:00')
    page.goto(origin + '/settings')
    expect(page.get_by_role('button', name='Friday', exact=True)).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    expect(page.locator('html')).to_have_attribute('data-motion', 'off')
    tokens = lambda: page.evaluate("Object.fromEntries(['--bg','--gradient-start','--gradient-end','--accent'].map(k=>[k,document.documentElement.style.getPropertyValue(k)]))")
    noon = tokens()
    for width in [1440, 1024, 768, 390, 320]:
        page.set_viewport_size({'width':width, 'height':1000})
        assert page.evaluate('document.documentElement.scrollWidth') <= width, width
        page.get_by_role('button', name='Friday', exact=True).focus()
        assert page.get_by_role('button', name='Friday', exact=True).evaluate('(e)=>getComputedStyle(e).outlineStyle') == 'solid'
        page.screenshot(path=str(base / f'settings-light-{width}.png'), full_page=True)
    page.set_viewport_size({'width':1320, 'height':1000})
    page.get_by_label('Friday first gradient color', exact=True).fill('#ff33aa')
    page.get_by_label('Friday second gradient color', exact=True).fill('#2277ff')
    assert tokens() != noon
    saved = page.evaluate("JSON.parse(localStorage.getItem('blackcat.theme'))")
    assert saved['days'][5] == {'start':'#ff33aa', 'end':'#2277ff'}
    customized = tokens(); page.reload()
    expect(page.get_by_label('Friday first gradient color', exact=True)).to_have_value('#ff33aa')
    assert tokens() == customized
    phases.append('custom colors apply immediately and survive reload')

    # CSS animation runs independently of pointer movement or the 30-second theme clock.
    page.emulate_media(reduced_motion='no-preference')
    expect(page.locator('html')).to_have_attribute('data-motion', 'full')
    backdrop = page.locator('[data-ambient-background="workspace"]')
    layer = backdrop.locator('span').first
    assert backdrop.evaluate('(e)=>getComputedStyle(e).pointerEvents') == 'none'
    page.wait_for_function("document.querySelector('[data-ambient-background=workspace] span').getAnimations()[0]?.playState === 'running'")
    before_flow = layer.evaluate('(e)=>e.getAnimations()[0].currentTime')
    page.wait_for_timeout(200)
    assert layer.evaluate('(e)=>e.getAnimations()[0].currentTime') > before_flow
    first_position = layer.evaluate('(e)=>getComputedStyle(e).transform')
    layer.evaluate('(e)=>{e.getAnimations()[0].currentTime=24000}')
    assert layer.evaluate('(e)=>getComputedStyle(e).transform') != first_position
    page.screenshot(path=str(base / 'flowing-gradients.png'), full_page=True)
    page.get_by_label('Background', exact=True).select_option('still')
    expect(page.locator('html')).to_have_attribute('data-background', 'still')
    page.wait_for_function("document.querySelector('[data-ambient-background=workspace] span').getAnimations()[0]?.playState === 'paused'")
    assert page.evaluate("JSON.parse(localStorage.getItem('blackcat.theme')).background") == 'still'
    page.reload()
    expect(page.get_by_label('Background', exact=True)).to_have_value('still')
    expect(layer).to_have_css('animation-play-state', 'paused')
    page.get_by_label('Background', exact=True).select_option('flow')
    expect(layer).to_have_css('animation-play-state', 'running')
    page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
    expect(layer).to_have_css('animation-play-state', 'paused')
    page.evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))")
    expect(layer).to_have_css('animation-play-state', 'running')
    page.get_by_label('Motion level', exact=True).select_option('off')
    expect(layer).to_have_css('animation-name', 'none')
    page.get_by_label('Motion level', exact=True).select_option('full')
    page.emulate_media(reduced_motion='reduce')
    expect(page.locator('html')).to_have_attribute('data-motion', 'off')
    expect(layer).to_have_css('animation-name', 'none')
    phases.append('background drifts without input, still choice persists, and hidden/off/reduced-motion pause it')

    page.get_by_role('button', name='Monday', exact=True).click()
    page.get_by_label('Monday first gradient color', exact=True).fill('#123456')
    assert tokens() == customized
    page.get_by_label('Preview brightness', exact=True).select_option('22')
    preview = page.get_by_label('Monday gradient preview', exact=True)
    night_preview = preview.evaluate('(e)=>getComputedStyle(e).backgroundImage')
    page.get_by_label('Preview brightness', exact=True).select_option('9')
    assert preview.evaluate('(e)=>getComputedStyle(e).backgroundImage') != night_preview
    assert tokens() == customized
    page.get_by_role('button', name='Reset Monday colors', exact=True).click()
    assert page.evaluate("JSON.parse(localStorage.getItem('blackcat.theme')).days[5]") == saved['days'][5]
    phases.append('editing and previewing another day leaves today unchanged; reset is per day')

    page.get_by_role('button', name='Friday', exact=True).click()
    page.clock.set_system_time(time='2026-10-02T22:00:00-04:00')
    page.clock.run_for(30_100)
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    assert tokens()['--bg'] != customized['--bg']
    page.screenshot(path=str(base / 'settings-dark.png'), full_page=True)
    page.get_by_label('Brightness', exact=True).select_option('light')
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    page.get_by_label('Brightness', exact=True).select_option('auto')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    before_midnight = tokens()
    page.clock.set_system_time(time='2026-10-03T00:00:01-04:00')
    page.clock.run_for(30_100)
    expect(page.locator('html')).to_have_attribute('data-theme-day', '6')
    assert tokens() != before_midnight
    page.clock.set_system_time(time='2026-10-03T12:00:00-04:00')
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    phases.append('open window updates at night and midnight, manual override and wake recovery work')

    other = context.new_page(); other.clock.install(time='2026-10-03T12:00:00-04:00'); other.goto(origin + '/settings')
    other.get_by_label('Brightness', exact=True).select_option('dark')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    expect(page.get_by_label('Brightness', exact=True)).to_have_value('dark')
    other.close(); phases.append('saved choices synchronize across windows')

    page.get_by_role('button', name='Saturday', exact=True).click()
    before_error = tokens()
    page.evaluate("() => { window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('Fixture storage full')}; }")
    page.get_by_label('Saturday first gradient color', exact=True).fill('#eeeeee')
    expect(page.get_by_role('alert')).to_contain_text('could not be saved')
    assert tokens() == before_error
    page.evaluate('() => { Storage.prototype.setItem=window.originalSetItem; }')
    page.evaluate("localStorage.setItem('blackcat.theme','broken')")
    page.reload()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    expect(page.get_by_label('Saturday first gradient color', exact=True)).to_have_value('#828b9c')
    phases.append('failed storage keeps saved colors and malformed storage uses safe defaults')
    context.close(); browser.close()

assert not errors, errors
assert not external, external
proof = {'passed':True, 'actualComponents':True, 'noServer':True, 'phases':phases, 'errors':errors, 'externalRequests':external}
(base / 'proof.json').write_text(json.dumps(proof, indent=2))
(Path(tempfile.gettempdir()) / 'blackcat-daily-theme-ui-path.txt').write_text(str(base))
print(json.dumps(proof), flush=True)
