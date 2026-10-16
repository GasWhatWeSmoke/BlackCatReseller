"""Synthetic regressions for raw behavior recovered from the beta8 installer."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker import ebay_policies,ebay_form,depop_form


class RecoveredLogicTests(unittest.TestCase):
    def test_departments_and_policy_annotations_keep_semantic_identity(self):
        for value in ('Mens','Male','Menswear'):
            self.assertEqual(ebay_form.department_for(value),'Men')
        for value in ('Unisex','Unisex Adult','Unisex Adults'):
            self.assertEqual(ebay_form.department_for(value),'Unisex Adults')
        self.assertEqual(ebay_form.policy_key('Standard Shipping (12 listings)'), 'standard shipping')
        self.assertNotEqual(ebay_form.policy_key('Standard Shipping'),ebay_form.policy_key('Express Shipping'))

    def test_color_families_do_not_change_original_shade(self):
        for shade,family in [('Navy','Blue'),('Charcoal','Grey'),('Light Blue','Blue'),('Lavender','Purple')]:
            choices=depop_form.color_candidates(shade)
            self.assertEqual(choices[0],shade)
            self.assertIn(family,choices)
        self.assertNotIn('Blue',depop_form.color_candidates('Unknown unusual shade'))


class RecoveredPolicyDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime=sync_playwright().start()
        cls.browser=cls.runtime.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.runtime.stop()

    def setUp(self):
        self.page=self.browser.new_page()
        self.addCleanup(self.page.close)

    def load(self,body):
        self.page.route('**/*',lambda route:route.fulfill(content_type='text/html',body=body))
        self.page.goto('https://www.ebay.com/bp/manage')

    def test_read_complete_policy_table_does_not_edit_any_policy(self):
        self.load('''<h1>Business policies</h1><table><thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead>
        <tbody><tr><td>Standard shipping</td><td>Shipping</td><td>Default</td></tr>
        <tr><td>Returns accepted</td><td>Returns</td><td></td></tr></tbody></table>''')
        result=ebay_policies.read_policies(self.page)
        self.assertTrue(result['complete'])
        self.assertEqual(result['policies'],[{'kind':'shipping','name':'Standard shipping','isDefault':True},
                                            {'kind':'return','name':'Returns accepted','isDefault':False}])

    def test_paginated_policy_read_includes_later_pages(self):
        self.load('''<h1>Business policies</h1><table><thead><tr><th>Name</th><th>Type</th></tr></thead>
        <tbody id="rows"><tr><td>Standard shipping</td><td>Shipping</td></tr></tbody></table>
        <button aria-label="Next page" onclick="document.getElementById('rows').innerHTML='<tr><td>Returns accepted</td><td>Returns</td></tr>';this.disabled=true">Next</button>''')
        result=ebay_policies.read_policies(self.page)
        self.assertEqual([p['name'] for p in result['policies']],['Standard shipping','Returns accepted'])

    def test_duplicate_policy_names_require_review(self):
        self.load('''<h1>Business policies</h1><table><thead><tr><th>Name</th><th>Type</th></tr></thead>
        <tbody><tr><td>Standard</td><td>Shipping</td></tr><tr><td>STANDARD</td><td>Shipping</td></tr></tbody></table>''')
        with self.assertRaisesRegex(ValueError,'duplicate policy names'):
            ebay_policies.read_policies(self.page)

    def test_policy_reader_rejects_other_origins(self):
        self.page.set_content('<h1>Business policies</h1>')
        with self.assertRaisesRegex(ValueError,'Finish signing into eBay'):
            ebay_policies.read_policies(self.page)

    def test_native_policy_selector_requires_unique_reviewed_name(self):
        self.load('''<label for="shipping">Shipping policy</label><select id="shipping">
        <option value="">Choose a shipping policy</option><option value="one">Standard (12 listings)</option>
        <option value="two">Express</option></select>''')
        with self.assertRaisesRegex(ValueError,'Choose an existing'):
            ebay_form.fill_policy(self.page,['Shipping policy'])
        self.assertEqual(ebay_form.fill_policy(self.page,['Shipping policy'],'Standard'),'Standard (12 listings)')
        self.assertEqual(self.page.locator('#shipping').input_value(),'one')


if __name__=='__main__':unittest.main()
