"""Depop's shade mapping commits an actual color chip."""
from pathlib import Path
import sys
import unittest
from playwright.sync_api import sync_playwright

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.assisted_browser import find_real_chrome
from black_cat_worker.depop_form import _fill_colors


class DepopColorDomTests(unittest.TestCase):
    def test_maroon_selects_burgundy_and_removes_an_inferred_red_chip(self):
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome())
            try:
                page=browser.new_page()
                page.set_content('''<div id="colors"><button aria-label="Remove Red" onclick="this.remove()">Red</button>
                  <input role="combobox" aria-label="Color" aria-controls="palette" aria-expanded="false"
                    onclick="palette.hidden=false;this.setAttribute('aria-expanded','true')"
                    onkeydown="if(event.key==='Escape'){palette.hidden=true;this.setAttribute('aria-expanded','false')}">
                  <div id="palette" role="listbox" hidden><div id="burgundy" role="option" onclick="selectShade()"><p>Burgundy</p></div></div></div>
                  <script>function selectShade(){const b=document.createElement('button');b.setAttribute('aria-label','Remove Burgundy');
                    b.textContent='Burgundy';b.onclick=()=>b.remove();colors.appendChild(b);palette.hidden=true}</script>''')
                reviewed=['Maroon','Burgundy']
                self.assertEqual(_fill_colors(page,reviewed),['Burgundy'])
                self.assertEqual(page.get_by_role('button',name='Remove Burgundy',exact=True).count(),1)
                self.assertEqual(page.get_by_role('button',name='Remove Red',exact=True).count(),0)
                self.assertEqual(reviewed,['Maroon','Burgundy'])
            finally:browser.close()
