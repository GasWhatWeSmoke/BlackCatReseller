import sys
import unittest
import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.research_listing import ebay_identity, normalize_snapshot, main, ENTRY_URL


class ResearchListingTests(unittest.TestCase):
    def test_reader_uses_the_broker_supported_entry_before_visiting_the_exact_listing(self):
        page=MagicMock();page.url='https://www.ebay.com/itm/123456789012'
        page.evaluate.return_value={'title':'Actual item','price':'US $24.99','buyable':True}
        context=MagicMock();context.__enter__.return_value=page
        with patch('black_cat_worker.research_listing.new_chrome_editor',return_value=context) as open_editor, patch('playwright.sync_api.sync_playwright') as playwright, patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps({'url':page.url}).encode()))), patch.object(sys,'stdout',io.StringIO()) as output:
            self.assertEqual(main(),0)
            self.assertEqual(open_editor.call_args.args[1],ENTRY_URL)
            page.goto.assert_called_once_with(page.url,wait_until='domcontentloaded',timeout=30_000)
            result=json.loads(output.getvalue().removeprefix('RESEARCH_DONE '))
            self.assertEqual(result['price'],24.99)

    def test_price_ranges_hidden_offers_and_missing_interest_stay_unknown(self):
        normal = normalize_snapshot({'title':'Shirt','price':'US $24.99','buyable':True})
        self.assertEqual(normal['price'],24.99)
        self.assertIsNone(normal['interest'])
        self.assertEqual(normal['kind'],'active')
        hidden = normalize_snapshot({'title':'Shirt','price':'$24.99','status':'Sold best offer accepted'})
        self.assertIsNone(hidden['price'])
        self.assertEqual(hidden['kind'],'unknown')
        self.assertIsNone(normalize_snapshot({'title':'Shirt','price':'$10.00 to $20.00'})['price'])

    def test_only_exact_public_ebay_items_are_read(self):
        self.assertEqual(ebay_identity('https://www.ebay.com/itm/123456789012'),'123456789012')
        for value in ['https://ebay.com.evil.test/itm/123456789012','http://www.ebay.com/itm/123456789012','https://www.ebay.com/sh/ord','https://u:p@www.ebay.com/itm/123456789012']:
            self.assertIsNone(ebay_identity(value))


if __name__ == '__main__': unittest.main()
