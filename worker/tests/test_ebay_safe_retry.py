from contextlib import contextmanager,ExitStack
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock,patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker import post_ebay as post


class EbaySafeRetryTests(unittest.TestCase):
    def run_main(self,reports):
        opened=[]
        @contextmanager
        def editor(*args,**kwargs):
            opened.append('open')
            page=MagicMock();page.url='https://www.ebay.com/sl/sell'
            try:yield page
            finally:opened.append('closed')
        with tempfile.TemporaryDirectory() as root, ExitStack() as stack:
            stack.enter_context(patch('sys.argv',['post_ebay','--sku','000001','--mode','post','--listing-stdin']))
            stack.enter_context(patch.object(post,'read_listing_input',return_value={}))
            stack.enter_context(patch.object(post,'canonical_item_and_photos',return_value=({'sku':'000001','itemId':1},['photo.jpg'])))
            stack.enter_context(patch.object(post.config,'load_settings',return_value={'dataRoot':root,'publish':{'ebayBrowser':{'enabled':True}}}))
            stack.enter_context(patch.object(post,'assert_publish_authorized'))
            stack.enter_context(patch('playwright.sync_api.sync_playwright'))
            stack.enter_context(patch.object(post,'new_chrome_editor',editor))
            runner=stack.enter_context(patch.object(post,'run_on_page',side_effect=reports))
            stack.enter_context(patch('builtins.print'))
            result=post.main()
        return result,opened,runner.call_count

    def test_timeout_before_submission_reopens_once_after_closing_the_first_editor(self):
        result,events,calls=self.run_main([{'outcome':'failed','submissionStarted':False,'reason':'TimeoutError: editor loading'},
                                          {'outcome':'posted','submissionStarted':True,'url':'https://www.ebay.com/itm/123456789012'}])
        self.assertEqual((result,calls),(0,2))
        self.assertEqual(events,['open','closed','open','closed'])

    def test_possible_submission_and_account_verification_are_never_retried(self):
        for report in [{'outcome':'failed','submissionStarted':True,'reason':'TimeoutError: response missing'},
                       {'outcome':'failed','submissionStarted':False,'reason':'TimeoutError: response missing','url':'https://www.ebay.com/itm/123456789012'},
                       {'outcome':'failed','submissionStarted':False,'reason':'ValueError: Complete account verification'}]:
            with self.subTest(report=report):
                result,events,calls=self.run_main([report])
                self.assertEqual((result,calls),(1,1))
                self.assertEqual(events,['open','closed'])

    def test_a_second_timeout_stops_instead_of_looping(self):
        failure={'outcome':'failed','submissionStarted':False,'reason':'TimeoutError: editor loading'}
        result,events,calls=self.run_main([failure,failure])
        self.assertEqual((result,calls),(1,2))
