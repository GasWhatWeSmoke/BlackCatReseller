"""Operator-controlled marketplace login in a dedicated, ordinary Chrome window."""
import argparse
import os

from .assisted_browser import run_manual_login

MARKETPLACES = {
    "depop": ("Depop", "https://www.depop.com/login/"),
    "ebay": ("eBay", "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn"),
    "etsy": ("Etsy", "https://www.etsy.com/your/shops/me/dashboard"),
    "poshmark": ("Poshmark", "https://poshmark.com/login"),
    "mercari": ("Mercari", "https://www.mercari.com/mypage/listings/active/"),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--marketplace", choices=MARKETPLACES, required=True)
    parser.add_argument("--data-root", required=True)
    args = parser.parse_args()
    name, url = MARKETPLACES[args.marketplace]
    profile = os.path.join(os.path.abspath(args.data_root), f"{args.marketplace}-profile")
    try:
        run_manual_login(profile, url, platform_name=name)
    except Exception as exc:
        print(f"[login] {name}: {exc}", flush=True)
        return 1
    print("MARKETPLACE_LOGIN_DONE window-closed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
