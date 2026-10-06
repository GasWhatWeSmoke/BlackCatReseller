import sys
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock, call
from playwright.sync_api import sync_playwright, Locator, TimeoutError as BrowserTimeout, Error as BrowserError
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.post_depop import _retry_failed_photos
from black_cat_worker import post_depop


class DepopPhotoRetryTests(unittest.TestCase):
    def test_each_original_is_confirmed_before_the_next_without_a_large_combined_transfer(self):
        page, control = MagicMock(), MagicMock()
        page.query_selector_all.return_value = [control]; page.query_selector.return_value = control
        control.get_attribute.return_value = ''
        events=[]
        def send(value):
            if isinstance(value,list):raise BrowserError('Combined transfer exceeds the transport limit')
            events.append(('selected',value))
        def confirm(page,count):events.append(('verified',count));return count
        control.set_input_files.side_effect = send
        photos=['first.jpg','second.jpg']
        with patch.object(post_depop,'_photo_state',return_value={'total':0,'ready':0}), \
             patch.object(post_depop,'_wait_for_photos',side_effect=confirm) as verified:
            self.assertEqual(post_depop._upload_photos(page,photos),2)
        self.assertEqual(control.set_input_files.call_args_list,[call(photos[0]),call(photos[1])])
        self.assertEqual(verified.call_args_list,[call(page,1),call(page,2)])
        self.assertEqual(events,[('selected','first.jpg'),('verified',1),('selected','second.jpg'),('verified',2)])

    def test_other_file_errors_are_not_retried(self):
        page,control=MagicMock(),MagicMock();page.query_selector_all.return_value=[control]
        page.query_selector.return_value=control
        control.get_attribute.return_value='';control.set_input_files.side_effect=BrowserError('File is unreadable')
        with patch.object(post_depop,'_photo_state',return_value={'total':0,'ready':0}):
            with self.assertRaisesRegex(BrowserError,'unreadable'):post_depop._upload_photos(page,['first.jpg'])
        control.set_input_files.assert_called_once()

    def test_input_timeout_verifies_the_same_batch_without_duplicate_attachments(self):
        for multiple in [True, False]:
            with self.subTest(multiple=multiple):
                page, control = MagicMock(), MagicMock()
                page.query_selector_all.return_value = [control]
                page.query_selector.return_value = control
                control.get_attribute.return_value = '' if multiple else None
                control.set_input_files.side_effect = BrowserTimeout('Input selection timed out')
                photos = ['first.jpg','second.jpg']
                with patch.object(post_depop,'_photo_state',return_value={'total':0,'ready':0}), \
                     patch.object(post_depop,'_wait_for_photos',return_value=2) as verified:
                    self.assertEqual(post_depop._upload_photos(page,photos),2)
                self.assertEqual(control.set_input_files.call_args_list,[call(photos[0]),call(photos[1])])
                self.assertEqual(verified.call_args_list,[call(page,1),call(page,2)])

    def test_timed_out_input_never_accepts_an_incomplete_gallery(self):
        page, control = MagicMock(), MagicMock()
        page.query_selector_all.return_value = [control]
        page.query_selector.return_value = control
        control.get_attribute.return_value = ''
        control.set_input_files.side_effect = BrowserTimeout('Input selection timed out')
        with patch.object(post_depop,'_photo_state',return_value={'total':0,'ready':0}), \
             patch.object(post_depop,'_wait_for_photos',side_effect=ValueError('Only 1 of 2 photos finished')):
            with self.assertRaisesRegex(ValueError,'Only 1 of 2'):
                post_depop._upload_photos(page,['first.jpg','second.jpg'])
        control.set_input_files.assert_called_once()

    def test_native_retry_disappearing_between_visibility_and_enabled_checks_is_rechecked(self):
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                page = browser.new_page()
                page.set_content('''<section><div class="thumbnailContainer"><img></div><span>Upload failed</span>
                  <button onclick="window.clicked=true">Retry</button></section>''')
                original = Locator.is_enabled
                def finished_upload(locator, **kwargs):
                    page.locator('button').evaluate('button=>button.remove()')
                    return original(locator, timeout=100)
                attempts = {}
                with patch.object(Locator, 'is_enabled', finished_upload):
                    _retry_failed_photos(page, 1, attempts)
                self.assertEqual(attempts, {})
                self.assertIsNone(page.evaluate('window.clicked'))
                self.assertEqual(page.locator('.thumbnailContainer img').count(), 1)
            finally:browser.close()

    def test_native_upload_finishing_during_retry_delay_does_not_wait_for_a_removed_button(self):
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                page = browser.new_page()
                page.set_content('''<section><div class="thumbnailContainer"><img></div><span>Upload failed</span>
                  <button onclick="window.clicked=true">Retry</button></section>
                  <script>setTimeout(()=>document.querySelector('button').remove(),200)</script>''')
                attempts = {}
                _retry_failed_photos(page,1,attempts)
                self.assertEqual(attempts,{})
                self.assertIsNone(page.evaluate('window.clicked'))
            finally:browser.close()

    def test_only_failed_existing_tiles_are_retried_with_a_hard_limit(self):
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=find_real_chrome())
            try:
                page = browser.new_page()
                page.set_content('''<section><div class="thumbnailContainer"><img><span>Uploaded</span></div></section>
                  <section><div class="thumbnailContainer"><img></div><span>Upload failed</span>
                    <button onclick="window.retries=(window.retries||0)+1">Retry</button></section>
                  <aside>Unrelated operation<button onclick="window.wrong=true">Retry</button></aside>''')
                attempts = {}
                for _ in range(4): _retry_failed_photos(page,2,attempts)
                self.assertEqual(attempts,{1:2})
                self.assertEqual(page.evaluate('window.retries'),2)
                self.assertIsNone(page.evaluate('window.wrong'))
                self.assertEqual(page.locator('.thumbnailContainer img').count(),2)
                _retry_failed_photos(page,3,{})
                self.assertEqual(page.evaluate('window.retries'),2)
            finally: browser.close()
