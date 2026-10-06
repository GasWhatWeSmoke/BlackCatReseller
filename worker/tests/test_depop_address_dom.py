"""Saved-address selection without any marketplace requests."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.depop_form import shipping_address


class DepopAddressDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=find_real_chrome())

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route('**/*', lambda route: route.abort())
        self.page.set_content('''<div data-testid="address-container"><h3>Shipping from</h3>
            <div data-testid="selectAddressRadio"><input type="radio" name="selectAddressRadio" id="saved" value="saved" checked>
            <label for="saved">Seller, 1 Fixture Street, Example, FL 12345, US</label></div>
            <button onclick="throw Error('Must not edit')">Edit</button><button onclick="throw Error('Must not remove')">Remove</button></div>''')

    def tearDown(self): self.page.close()

    def test_selected_card_is_preserved_and_confirmed_without_editing(self):
        before = shipping_address(self.page)
        self.assertEqual(before[:2], ('radio', 'saved'))
        self.assertEqual(shipping_address(self.page, select=False), before)

    def test_changed_address_does_not_match_original_confirmation(self):
        before = shipping_address(self.page)
        self.page.locator('label').evaluate("e=>e.textContent='Different saved address'")
        self.assertNotEqual(shipping_address(self.page, select=False), before)

    def test_only_initial_fill_may_select_a_sole_unselected_saved_address(self):
        self.page.locator('input').evaluate('e=>e.checked=false')
        with self.assertRaisesRegex(ValueError, 'Choose one saved'):
            shipping_address(self.page, select=False)
        self.assertEqual(shipping_address(self.page)[:2], ('radio', 'saved'))

    def test_multiple_unselected_cards_require_operator_choice(self):
        self.page.locator('input').evaluate('e=>e.checked=false')
        self.page.get_by_test_id('selectAddressRadio').evaluate("e=>e.insertAdjacentHTML('beforeend','<input type=radio name=selectAddressRadio id=second value=second><label for=second>Second saved address</label>')")
        with self.assertRaisesRegex(ValueError, 'Choose one saved'):
            shipping_address(self.page)

    def test_existing_combobox_remains_supported(self):
        self.page.set_content('<label>Select an address<input role="combobox" value="Existing saved address"></label>')
        self.assertEqual(shipping_address(self.page, select=False), ('combobox', 'Existing saved address'))

    def test_visible_address_service_error_is_not_an_operator_selection_problem(self):
        self.page.set_content('''<div data-testid="address-container"><div>
          Something went wrong. If the problem persists, please try again later.
          </div></div>''')
        for select in [True, False]:
            with self.assertRaisesRegex(ValueError,'saved shipping addresses are temporarily unavailable'):
                shipping_address(self.page,select=select)

    def test_hidden_or_unrelated_errors_do_not_replace_a_valid_saved_address(self):
        self.page.evaluate('''()=>{
          document.querySelector('[data-testid="address-container"]').insertAdjacentHTML('beforeend',
            '<div hidden>Something went wrong. If the problem persists, please try again later.</div>');
          document.body.insertAdjacentHTML('beforeend',
            '<div>Something went wrong. If the problem persists, please try again later.</div>');
        }''')
        self.assertEqual(shipping_address(self.page,select=False)[:2],('radio','saved'))

    def address_error_with_shipping_controls(self, recover=True, multiple=False, delay=0):
        self.page.set_content('''<input type="radio" name="shipping" id="usps" checked><label for="usps">Depop Shipping (via USPS)</label>
          <input type="radio" name="shipping" id="manual"><label for="manual">Other</label>
          <div data-testid="address-container">Something went wrong. Please try again later.</div>''')
        self.page.evaluate('''options=>{
          window.shippingChanges=0;
          document.querySelectorAll('input[name=shipping]').forEach(input=>input.addEventListener('change',()=>{
            window.shippingChanges++;
            if(input.id==='usps'&&options.recover){
              const render=()=>{document.querySelector('[data-testid="address-container"]').innerHTML=
                '<div data-testid="selectAddressRadio"><input type="radio" name="selectAddressRadio" id="saved" value="saved"><label for="saved">Existing saved address</label></div>' +
                (options.multiple?'<div data-testid="selectAddressRadio"><input type="radio" name="selectAddressRadio" id="second" value="second"><label for="second">Another saved address</label></div>':'');};
              if(options.delay){document.querySelector('[data-testid="address-container"]').textContent='Loading addresses';setTimeout(render,options.delay);}else render();
            }
          }));
        }''', {'recover':recover,'multiple':multiple,'delay':delay})

    def test_recovery_waits_for_saved_address_after_the_error_disappears(self):
        self.address_error_with_shipping_controls(delay=500)
        self.assertEqual(shipping_address(self.page,recovery_timeout=2000)[:2],('radio','saved'))
        self.assertTrue(self.page.locator('#usps').is_checked())
        self.assertEqual(self.page.evaluate('window.shippingChanges'),2)

    def test_initial_widget_error_recovers_once_through_native_labels_without_changing_shipping(self):
        self.address_error_with_shipping_controls()
        self.assertEqual(shipping_address(self.page)[:2],('radio','saved'))
        self.assertTrue(self.page.locator('#usps').is_checked())
        self.assertEqual(self.page.evaluate('window.shippingChanges'),2)
        self.assertEqual(shipping_address(self.page,select=False)[:2],('radio','saved'))
        self.assertEqual(self.page.evaluate('window.shippingChanges'),2)

    def test_persistent_service_error_stops_after_one_shipping_cycle(self):
        self.address_error_with_shipping_controls(recover=False)
        with self.assertRaisesRegex(ValueError,'saved shipping addresses are temporarily unavailable'):
            shipping_address(self.page,recovery_timeout=200)
        self.assertTrue(self.page.locator('#usps').is_checked())
        self.assertEqual(self.page.evaluate('window.shippingChanges'),2)

    def test_final_verification_never_retries_or_changes_the_shipping_widget(self):
        self.address_error_with_shipping_controls()
        with self.assertRaisesRegex(ValueError,'saved shipping addresses are temporarily unavailable'):
            shipping_address(self.page,select=False)
        self.assertEqual(self.page.evaluate('window.shippingChanges'),0)

    def test_recovered_multiple_addresses_still_require_the_seller_to_choose(self):
        self.address_error_with_shipping_controls(multiple=True)
        with self.assertRaisesRegex(ValueError,'Choose one saved'):
            shipping_address(self.page)
        self.assertEqual(self.page.locator('input[name=selectAddressRadio]:checked').count(),0)
        self.assertTrue(self.page.locator('#usps').is_checked())

    def test_recovery_does_not_replace_a_different_selected_shipping_method(self):
        self.address_error_with_shipping_controls()
        self.page.locator('label[for=manual]').click()
        with self.assertRaisesRegex(ValueError,'saved shipping addresses are temporarily unavailable'):
            shipping_address(self.page)
        self.assertTrue(self.page.locator('#manual').is_checked())
        self.assertEqual(self.page.evaluate('window.shippingChanges'),1)
