import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.work_browser import work_window_bounds, configure_work_page, keep_work_page_ready, verification_page


class WorkBrowserTests(unittest.TestCase):
    def test_broker_owned_visible_window_never_requests_a_second_cdp_attachment(self):
        page = MagicMock()
        configure_work_page(page, native_window=True)
        keep_work_page_ready(page)
        page.context.new_cdp_session.assert_not_called()
        page.bring_to_front.assert_not_called()
        page.wait_for_function.assert_called_once_with('document.visibilityState === "visible"')

    def test_only_owned_marked_pages_use_virtual_focus_and_never_bring_the_window_forward(self):
        page = MagicMock()
        configure_work_page(page)
        keep_work_page_ready(page)
        page.bring_to_front.assert_not_called()
        session = page.context.new_cdp_session.return_value
        self.assertEqual(session.send.call_args.args, ('Emulation.setFocusEmulationEnabled', {'enabled': True}))
        legacy = MagicMock()
        keep_work_page_ready(legacy)
        legacy.bring_to_front.assert_called_once()

    def test_existing_profile_window_is_placed_without_activation_commands(self):
        page = MagicMock()
        session = page.context.new_cdp_session.return_value
        session.send.return_value = {'windowId': 42}
        bounds = {'left': -1800, 'top': 0, 'width': 1400, 'height': 900}
        configure_work_page(page, bounds)
        self.assertEqual(session.send.call_args_list[2].args, ('Browser.setWindowBounds', {'windowId': 42, 'bounds': bounds}))
        page.bring_to_front.assert_not_called()

    def test_display_snapshot_accepts_negative_coordinates_and_rejects_malformed_geometry(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'BLACKCAT_DATA_ROOT': root}):
            with self.assertRaisesRegex(ValueError, "Second-monitor"): work_window_bounds()
            file = Path(root) / 'crawler-display.json'
            bounds = {'left': -313, 'top': -1440, 'width': 1600, 'height': 1000}
            file.write_text(json.dumps({'version': 1, 'secondary': True, 'bounds': bounds}), encoding='utf-8')
            self.assertEqual(work_window_bounds(), bounds)
            file.write_text(json.dumps({'version': 1, 'secondary': False, 'bounds': bounds}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'second monitor'): work_window_bounds()
            for invalid in [{**bounds, 'width': True}, {**bounds, 'top': 999999}, {**bounds, 'height': -2}]:
                file.write_text(json.dumps({'version': 1, 'secondary': True, 'bounds': invalid}), encoding='utf-8')
                with self.assertRaises(ValueError): work_window_bounds()


class WorkBrowserDomTests(unittest.TestCase):
    def test_verification_contexts_keep_the_owner_alive_and_anonymous_checks_have_no_seller_cookies(self):
        from playwright.sync_api import sync_playwright
        from black_cat_worker.assisted_browser import find_real_chrome
        with patch('black_cat_worker.work_browser.work_window_bounds', return_value=None), sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                context = browser.new_context()
                context.add_cookies([{'name':'seller','value':'fixture','url':'https://example.test'}])
                owner = context.new_page()
                owner.set_content('<input value="owner stays intact">')
                configure_work_page(owner)
                for anonymous in [False, True]:
                    with verification_page(owner, anonymous=anonymous) as check:
                        check.set_content('<input>')
                        keep_work_page_ready(check)
                        check.locator('input').fill('verification page only')
                        self.assertEqual(bool(check.context.cookies()),not anonymous)
                        self.assertIsNotNone(check.__dict__.get('_blackcat_work_cdp'))
                    self.assertTrue(check.is_closed())
                    self.assertFalse(owner.is_closed())
                    self.assertEqual(owner.locator('input').input_value(),'owner stays intact')
            finally:browser.close()

    def test_background_page_inputs_uploads_and_animation_do_not_change_another_page(self):
        from playwright.sync_api import sync_playwright
        from black_cat_worker.assisted_browser import find_real_chrome
        with patch('black_cat_worker.work_browser.work_window_bounds', return_value=None), sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                context = browser.new_context()
                personal = context.new_page()
                personal.set_content('<input value="my untouched writing"><script>window.keys=0;document.onkeydown=()=>keys++</script>')
                work = context.new_page()
                work.set_content('''<input id="typing"><input type="file"><button onclick="window.clicked=true">Click</button>
                  <script>window.framesSeen=0;function tick(){framesSeen++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>''')
                personal.bring_to_front()
                configure_work_page(work)
                keep_work_page_ready(work)
                work.locator('#typing').press_sequentially('listing text')
                work.locator('input[type=file]').set_input_files({'name':'fixture.txt','mimeType':'text/plain','buffer':b'local fixture'})
                work.get_by_role('button',name='Click').click()
                work.wait_for_function('framesSeen>=3 && window.clicked===true')
                self.assertEqual(work.locator('#typing').input_value(),'listing text')
                self.assertEqual(work.locator('input[type=file]').evaluate('e=>e.files[0].name'),'fixture.txt')
                self.assertEqual(personal.locator('input').input_value(),'my untouched writing')
                self.assertEqual(personal.evaluate('window.keys'),0)
            finally:browser.close()
