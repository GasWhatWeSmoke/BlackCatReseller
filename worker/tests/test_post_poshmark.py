import os
import sys
import unittest
import tempfile
from pathlib import Path
from PIL import Image
from unittest.mock import MagicMock, patch
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from black_cat_worker import post_poshmark as post


class PoshmarkPostingTests(unittest.TestCase):
    def setUp(self):
        # These fixtures isolate native-form behavior. Real CLI/reservation
        # checks live in test_final_publication_authorization.py.
        authorization = patch.object(post, "assert_publish_authorized")
        authorization.start()
        self.addCleanup(authorization.stop)

    def native_response(self, identifier='abcdef123456789012345678'):
        response=MagicMock()
        response.url=f'https://poshmark.com/vm-rest/posts/{identifier}/status/published?app_version=2.55'
        response.request.method='PUT'
        response.json.return_value={'error':{'errorType':'ValidationError','statusCode':400,
                                            'stackTrace':'private details','userMessage':{'text':'private details'}}}
        return response

    def test_native_error_reads_only_exact_listing_writes_and_safe_error_fields(self):
        identifier='abcdef123456789012345678';response=self.native_response()
        self.assertEqual(post.native_write_error(response,identifier),'Poshmark rejected publication: ValidationError (400)')
        self.assertIsNone(post.native_write_error(response,'000000000000000000000000'))
        response.request.method='GET';self.assertIsNone(post.native_write_error(response,identifier))
        response.request.method='PUT';response.url=response.url.replace('poshmark.com/','poshmark.com.evil.test/')
        self.assertIsNone(post.native_write_error(response,identifier))
        response=self.native_response();response.json.return_value={'status':'published'}
        self.assertIsNone(post.native_write_error(response,identifier))
        response.json.return_value={'error':{'errorType':'error with private details'}}
        self.assertIsNone(post.native_write_error(response,identifier))

    def test_native_rejection_is_reported_without_reclicking_or_erasing_uncertainty(self):
        page,button=MagicMock(),MagicMock()
        def verify(*args):
            page.on.call_args.args[1](self.native_response())
            raise ValueError('public page unavailable')
        with patch.object(post,'fill_listing_fields',return_value={}),patch.object(post,'attach_photos',return_value=3), \
             patch.object(post,'prepare_submission',return_value=(button,'abcdef123456789012345678')):
            result=post.run_on_page(page,{'title':'Shirt'},['a','b','c'],'post',verify)
        self.assertEqual(result['outcome'],'failed');self.assertTrue(result['submissionStarted'])
        self.assertIn('Poshmark rejected publication: ValidationError (400)',result['reason'])
        self.assertNotIn('private details',result['reason']);self.assertIn('url',result)
        button.click.assert_called_once();page.remove_listener.assert_called_once_with('response',page.on.call_args.args[1])

    def test_prohibited_item_certification_is_reported_as_a_seller_decision(self):
        identifier='abcdef123456789012345678';response=self.native_response()
        response.json.return_value={'error':{'errorType':'PostValidationError','statusCode':400,
            'params':{'certify_action':True,'certify_reason':'not_allowed'}}}
        self.assertIn('requires seller certification',post.native_write_error(response,identifier))
        response.json.return_value['error']['params']['certify_action']='true'
        self.assertEqual(post.native_write_error(response,identifier),'Poshmark rejected publication: PostValidationError (400)')

    def run_case(self, mode="post", click_error=None, verify_error=None):
        page, button = MagicMock(), MagicMock()
        button.click.side_effect = click_error
        verify = MagicMock(return_value="https://poshmark.com/listing/shirt-abcdef123456789012345678", side_effect=verify_error)
        with patch.object(post, "fill_listing_fields", return_value={}), patch.object(post, "attach_photos", return_value=3), \
             patch.object(post, "prepare_submission", return_value=(button, "abcdef123456789012345678")):
            result = post.run_on_page(page, {"title": "Shirt"}, ["a", "b", "c"], mode, verify)
        return result, button, verify

    def test_photo_copies_survive_submission_and_verification_then_are_cleaned(self):
        from black_cat_worker.poshmark_form import upload_photo_copies
        for fails in [False,True]:
            with self.subTest(verification_fails=fails), tempfile.TemporaryDirectory() as directory:
                source=Path(directory,'source.jpg');Image.new('RGB',(90,120),'blue').save(source);original=source.read_bytes();copies=[]
                page,button=MagicMock(),MagicMock()
                def attach(page,photos,*,lifetime):
                    copies.extend(lifetime.enter_context(upload_photo_copies(photos)))
                    return len(copies)
                def check_files(*args):
                    self.assertTrue(copies)
                    self.assertTrue(all(Path(value).is_file() for value in copies))
                button.click.side_effect=check_files
                def verify(*args):
                    check_files()
                    if fails:raise ValueError('public verification unavailable')
                    return 'https://poshmark.com/listing/shirt-abcdef123456789012345678'
                with patch.object(post,'fill_listing_fields',return_value={}), \
                     patch.object(post,'attach_photos',side_effect=attach), \
                     patch.object(post,'prepare_submission',return_value=(button,'abcdef123456789012345678')):
                    result=post.run_on_page(page,{'title':'Shirt'},[str(source)],'post',verify)
                self.assertEqual(result['outcome'],'failed' if fails else 'posted')
                self.assertTrue(result['submissionStarted']);button.click.assert_called_once()
                self.assertTrue(all(not Path(value).exists() for value in copies))
                self.assertEqual(source.read_bytes(),original)

    def test_fill_mode_never_clicks_or_claims_publication(self):
        result, button, verify = self.run_case("fill")
        self.assertEqual(result["outcome"], "filled")
        self.assertFalse(result["submissionStarted"])
        button.click.assert_not_called()
        verify.assert_not_called()

    def test_final_click_timeout_is_uncertain(self):
        result, button, verify = self.run_case(click_error=TimeoutError("response lost"))
        self.assertEqual(result["outcome"], "failed")
        self.assertTrue(result["submissionStarted"])
        button.click.assert_called_once()
        verify.assert_not_called()

    def test_public_verification_failure_never_reports_success(self):
        result, _, verify = self.run_case(verify_error=ValueError("public page unavailable"))
        self.assertEqual(result["outcome"], "failed")
        self.assertTrue(result["submissionStarted"])
        verify.assert_called_once()

    def test_preparation_failure_is_unsubmitted(self):
        with patch.object(post, "fill_listing_fields", side_effect=ValueError("size needs review")):
            result = post.run_on_page(MagicMock(), {}, [], "post")
        self.assertFalse(result["submissionStarted"])

    def test_success_requires_verification_of_the_same_listing(self):
        result, button, verify = self.run_case()
        self.assertEqual(result["outcome"], "posted")
        button.click.assert_called_once()
        self.assertEqual(verify.call_args.args[1:], ("abcdef123456789012345678", "Shirt"))

    def test_identity_rejects_wrong_ids_and_lookalike_hosts(self):
        identity = "abcdef123456789012345678"
        self.assertEqual(post.listing_url(f"https://www.poshmark.com/listing/Shirt-{identity}?tracking=1", identity), f"https://poshmark.com/listing/Shirt-{identity}")
        for url in ["https://poshmark.com/create-listing", f"https://poshmark.com.evil.test/listing/shirt-{identity}",
                    f"https://user:pass@poshmark.com/listing/shirt-{identity}", "https://poshmark.com/listing/shirt-000000000000000000000000"]:
            self.assertIsNone(post.listing_url(url, identity))


if __name__ == "__main__": unittest.main()
