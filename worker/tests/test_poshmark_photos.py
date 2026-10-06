from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack,contextmanager
from unittest.mock import patch
from PIL import Image,ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.poshmark_form import upload_photo_copies


class PoshmarkPhotoTests(unittest.TestCase):
    def test_browser_can_read_selected_files_after_attachment_returns(self):
        from playwright.sync_api import sync_playwright
        from black_cat_worker.assisted_browser import find_real_chrome
        from black_cat_worker.poshmark_form import attach_photos
        with tempfile.TemporaryDirectory() as directory, sync_playwright() as pw:
            source=Path(directory,'source.jpg');Image.new('RGB',(90,120),'blue').save(source);original=source.read_bytes();copies=[]
            @contextmanager
            def capture(photos):
                with upload_photo_copies(photos) as prepared:
                    copies.extend(prepared);yield prepared
            browser=pw.chromium.launch(headless=True,executable_path=find_real_chrome());page=browser.new_page()
            page.route('**/*',lambda route:route.abort())
            page.set_content('''<input id="img-file-input" type="file" multiple><h2 id="heading">Select a Covershot.</h2>
              <button onclick="heading.hidden=true;for(const file of document.querySelector('input').files){const reader=new FileReader();reader.onload=()=>{const image=new Image();image.className='listing-editor__image';image.src=reader.result;document.body.append(image)};reader.readAsDataURL(file)}">Apply</button>''')
            try:
                with patch('black_cat_worker.poshmark_form.upload_photo_copies',side_effect=capture), ExitStack() as lifetime:
                    self.assertEqual(attach_photos(page,[str(source)],lifetime=lifetime),1)
                    self.assertTrue(all(Path(value).exists() for value in copies))
                    sizes=page.evaluate("async()=>await Promise.all([...document.querySelector('input').files].map(async file=>(await file.arrayBuffer()).byteLength))")
                    self.assertEqual(len(sizes),1);self.assertGreater(sizes[0],0)
                self.assertTrue(all(not Path(value).exists() for value in copies))
                self.assertEqual(source.read_bytes(),original)
            finally:browser.close()

    def test_portrait_upload_keeps_all_four_edges_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root,'000008_01.png')
            picture=Image.new('RGB',(120,120),'gray');draw=ImageDraw.Draw(picture)
            corners=[((0,0,25,25),'red'),((94,0,119,25),'blue'),((0,94,25,119),'green'),((94,94,119,119),'yellow')]
            for rectangle,color in corners:draw.rectangle(rectangle,fill=color)
            picture.save(source);before=source.read_bytes()
            with upload_photo_copies([str(source)]) as copies:
                copy=Path(copies[0]);self.assertNotEqual(copy,source)
                with Image.open(copy) as result:
                    self.assertEqual(result.size,(120,160))
                    self.assertEqual(result.getpixel((60,2)),(255,255,255))
                    for x,y in [(10,10),(109,10),(10,109),(109,109)]:
                        self.assertLessEqual(max(abs(a-b) for a,b in zip(result.getpixel((x,y+20)),picture.getpixel((x,y)))),3)
            self.assertFalse(copy.exists());self.assertEqual(source.read_bytes(),before)

    def test_portrait_and_transparent_inputs_preserve_shape_and_white_background(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root,'000008_01.png')
            picture=Image.new('RGBA',(90,120),(0,0,255,0));ImageDraw.Draw(picture).rectangle((20,20,70,100),fill='red');picture.save(source)
            with upload_photo_copies([str(source)]) as copies:
                with Image.open(copies[0]) as result:
                    self.assertEqual(result.size,(90,120))
                    self.assertEqual(result.getpixel((5,5)),(255,255,255))
                    self.assertGreater(result.getpixel((45,60))[0],250)
