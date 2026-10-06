"""Generate the Black Cat Agent app icon (black cat head + moon) → build/icon.ico + .png.

Pure-PIL (already in the worker venv), no external assets. Run:
  worker/.venv/Scripts/python.exe scripts/make-icon.py
"""
import os
from PIL import Image, ImageDraw

N = 1024  # supersample, then downscale for crisp small sizes
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
os.makedirs(OUT, exist_ok=True)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make() -> Image.Image:
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = N / 512.0  # scale factor (coords authored at 512)

    def S(v):
        return v * s

    # Dark rounded-square background (reads on any taskbar/desktop).
    rounded_rect(d, [S(8), S(8), S(504), S(504)], radius=S(110), fill=(13, 13, 13, 255))
    rounded_rect(d, [S(8), S(8), S(504), S(504)], radius=S(110), fill=None)
    d.rounded_rectangle([S(8), S(8), S(504), S(504)], radius=S(110), outline=(40, 40, 40, 255), width=int(S(4)))

    # Pale "moon" the black cat sits against (gives the black silhouette contrast).
    moon_c, moon_r = (S(256), S(250)), S(168)
    d.ellipse([moon_c[0] - moon_r, moon_c[1] - moon_r, moon_c[0] + moon_r, moon_c[1] + moon_r],
              fill=(238, 238, 240, 255))

    black = (8, 8, 8, 255)
    # Cat ears (pointy triangles) — drawn first so the head circle tucks over their base.
    d.polygon([(S(150), S(212)), (S(196), S(96)), (S(258), S(196))], fill=black)   # left
    d.polygon([(S(362), S(212)), (S(316), S(96)), (S(254), S(196))], fill=black)   # right
    # inner ear hint
    d.polygon([(S(176), S(196)), (S(199), S(140)), (S(228), S(192))], fill=(60, 60, 64, 255))
    d.polygon([(S(336), S(196)), (S(313), S(140)), (S(284), S(192))], fill=(60, 60, 64, 255))

    # Head
    hc, hr = (S(256), S(288)), S(132)
    d.ellipse([hc[0] - hr, hc[1] - hr, hc[0] + hr, hc[1] + hr], fill=black)

    # Eyes — bright green almonds with slit pupils (unmistakably a cat).
    green = (124, 252, 0, 255)
    for ex in (S(214), S(298)):
        ey = S(286)
        d.ellipse([ex - S(28), ey - S(20), ex + S(28), ey + S(20)], fill=green)
        d.ellipse([ex - S(6), ey - S(19), ex + S(6), ey + S(19)], fill=black)  # slit pupil

    # Nose + tiny mouth
    d.polygon([(S(244), S(330)), (S(268), S(330)), (S(256), S(344))], fill=(120, 90, 95, 255))
    d.line([(S(256), S(344)), (S(256), S(356))], fill=(70, 70, 74, 255), width=int(S(3)))
    d.arc([S(238), S(344), S(256), S(366)], 20, 160, fill=(70, 70, 74, 255), width=int(S(3)))
    d.arc([S(256), S(344), S(274), S(366)], 20, 160, fill=(70, 70, 74, 255), width=int(S(3)))

    # Whiskers
    for dy in (-S(6), S(8), S(22)):
        d.line([(S(210), S(338) + dy), (S(120), S(330) + dy * 1.4)], fill=(225, 225, 228, 230), width=int(S(3)))
        d.line([(S(302), S(338) + dy), (S(392), S(330) + dy * 1.4)], fill=(225, 225, 228, 230), width=int(S(3)))

    return img


def main():
    big = make()
    png = big.resize((512, 512), Image.LANCZOS)
    png.save(os.path.join(OUT, "icon.png"))
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon.ico"), format="ICO", sizes=sizes)
    # A small 32px tray PNG too.
    big.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "tray.png"))
    print("wrote:", os.path.join(OUT, "icon.ico"), "+ icon.png + tray.png")


if __name__ == "__main__":
    main()
