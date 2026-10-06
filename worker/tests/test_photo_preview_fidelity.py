"""Lossy low-contrast previews versus real localized image changes."""
import io
from pathlib import Path
import sys
import tempfile
import unittest
import random
from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from black_cat_worker.mercari_native_form import image_matches


class PhotoPreviewFidelityTests(unittest.TestCase):
    def test_bicubic_downsized_preview_preserves_identity_but_not_crops_or_changed_graphics(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Image.new('RGB',(360,480),(35,85,140));draw=ImageDraw.Draw(source)
            draw.rectangle((40,60,145,310),fill=(240,230,210))
            draw.ellipse((185,220,325,430),fill=(20,130,40))
            for y in range(80,300,17):draw.text((48,y),'LABEL 12345',fill=(180,15,20))
            path=Path(directory,'source.png');source.save(path)
            def encoded(image):
                buffer=io.BytesIO();image.resize((90,120),Image.Resampling.BICUBIC).save(buffer,format='PNG')
                return buffer.getvalue()
            self.assertTrue(image_matches(path,encoded(source)))
            self.assertFalse(image_matches(path,encoded(source.crop((60,0,360,480)))))
            self.assertFalse(image_matches(path,encoded(ImageOps.mirror(source))))
            changed=source.copy();ImageDraw.Draw(changed).rectangle((180,80,310,190),fill=(245,25,15))
            self.assertFalse(image_matches(path,encoded(changed)))

    def test_resized_label_preview_uses_matching_sampling_without_accepting_a_different_photo(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Image.new('RGB',(800,800),(18,166,32))
            draw=ImageDraw.Draw(source);rng=random.Random(0)
            for _ in range(130):
                x,y=rng.randrange(800),rng.randrange(800);shade=rng.randrange(-3,4)
                draw.rectangle((x,y,min(799,x+rng.randrange(5,60)),min(799,y+rng.randrange(5,60))),
                               fill=(18+shade,166+shade,32+shade))
            draw.rectangle((270,90,620,710),fill=(245,245,245))
            for y in range(108,705,19):
                draw.text((279,y),'MADE IN USA 100% COTTON LABEL',fill=(190,10,30) if y%2 else (15,30,200))
            path=Path(directory,'source.png');source.save(path)
            preview=source.resize((128,128),Image.Resampling.LANCZOS)
            encoded=io.BytesIO();preview.save(encoded,format='JPEG',quality=90)
            self.assertTrue(image_matches(path,encoded.getvalue()))
            changed=io.BytesIO();ImageOps.mirror(preview).save(changed,format='JPEG',quality=90)
            self.assertFalse(image_matches(path,changed.getvalue()))

    def test_chroma_subsampling_on_colored_fabric_is_not_a_different_photo(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Image.new('RGB',(64,64))
            source.putdata([(60+(x//4+y//4)%2*(4 if x>=32 and y>=32 else 1),
                             35+(x//4+y//4)%2,130+(x//4+y//4)%2)
                            for y in range(64) for x in range(64)])
            path=Path(directory,'source.png');source.save(path)
            encoded=io.BytesIO();source.save(encoded,format='JPEG',quality=65)
            self.assertTrue(image_matches(path,encoded.getvalue()))

    def test_jpeg_quantization_of_subtle_texture_is_still_the_same_photo(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Image.new('RGB',(64,64))
            source.putdata([(100+(x//4+y//4)%2,)*3 for y in range(64) for x in range(64)])
            path=Path(directory,'source.png');source.save(path)
            encoded=io.BytesIO();source.save(encoded,format='JPEG',quality=90)
            self.assertTrue(image_matches(path,encoded.getvalue()))

    def test_small_global_difference_does_not_hide_a_localized_change(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Image.new('RGB',(64,64),(100,100,100))
            path=Path(directory,'source.png');source.save(path)
            changed=source.copy();changed.paste((104,104,104),(16,8,24,56))
            encoded=io.BytesIO();changed.save(encoded,format='PNG')
            self.assertFalse(image_matches(path,encoded.getvalue()))
