"""Regenerate the app icons (build/icon.png, build/tray.png, build/icon.ico) from the
"Midnight Cat" mark — the same cat as src/components/CatMark.tsx, so app icon, tray,
and in-app brand all match.

Run with the worker venv (it has Playwright + Pillow):
  worker/.venv/Scripts/python.exe scripts/make-icons.py
"""
from __future__ import annotations

import os

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")

ACCENT = "#b7ff2e"

# The cat head — identical geometry to CatMark.tsx (viewBox 0 0 32 32).
CAT_PATH = (
    "M5 13 L4 4 L12 8.5 C13.2 8.1 14.6 7.9 16 7.9 C17.4 7.9 18.8 8.1 20 8.5 L28 4 L27 13 "
    "C28.2 15 29 17.2 29 19.5 C29 26 23.2 29.5 16 29.5 C8.8 29.5 3 26 3 19.5 "
    "C3 17.2 3.8 15 5 13 Z"
)


def eyes(fill_eye: str, fill_slit: str) -> str:
    return (
        f'<ellipse cx="11.2" cy="18.6" rx="2.1" ry="3.1" fill="{fill_eye}"/>'
        f'<ellipse cx="20.8" cy="18.6" rx="2.1" ry="3.1" fill="{fill_eye}"/>'
        f'<ellipse cx="11.2" cy="18.6" rx="0.7" ry="2.4" fill="{fill_slit}"/>'
        f'<ellipse cx="20.8" cy="18.6" rx="0.7" ry="2.4" fill="{fill_slit}"/>'
    )


# App icon (512): black rounded tile, thin green ring, green-outlined cat with green eyes.
APP_SVG = f"""
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="492" height="492" rx="110" fill="#000000"/>
  <rect x="10" y="10" width="492" height="492" rx="110" fill="none"
        stroke="{ACCENT}" stroke-width="12" opacity="0.85"/>
  <g transform="translate(94,100) scale(10.1)">
    <path d="{CAT_PATH}" fill="#000" stroke="{ACCENT}" stroke-width="1.8" stroke-linejoin="round"/>
    {eyes(ACCENT, "#000")}
  </g>
</svg>
"""

# Tray glyph (rendered 64, Electron resizes to 16): solid green silhouette so it stays
# legible at tray size on any taskbar; eye slits punched out in black.
TRAY_SVG = f"""
<svg width="64" height="64" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <path d="{CAT_PATH}" fill="{ACCENT}" stroke="{ACCENT}" stroke-width="1" stroke-linejoin="round"/>
  <ellipse cx="11.2" cy="18.6" rx="1.9" ry="2.9" fill="#000"/>
  <ellipse cx="20.8" cy="18.6" rx="1.9" ry="2.9" fill="#000"/>
</svg>
"""


def shoot(page, svg: str, px: int, out: str) -> None:
    page.set_viewport_size({"width": px, "height": px})
    page.set_content(
        f"<html><body style='margin:0;background:transparent'>{svg}</body></html>"
    )
    page.screenshot(path=out, omit_background=True, clip={"x": 0, "y": 0, "width": px, "height": px})
    print(f"wrote {out}")


def main() -> None:
    os.makedirs(BUILD, exist_ok=True)
    icon_png = os.path.join(BUILD, "icon.png")
    tray_png = os.path.join(BUILD, "tray.png")
    icon_ico = os.path.join(BUILD, "icon.ico")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        shoot(page, APP_SVG, 512, icon_png)
        shoot(page, TRAY_SVG, 64, tray_png)
        browser.close()

    # Multi-size .ico for the Windows installer/taskbar.
    img = Image.open(icon_png)
    img.save(icon_ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print(f"wrote {icon_ico}")


if __name__ == "__main__":
    main()
