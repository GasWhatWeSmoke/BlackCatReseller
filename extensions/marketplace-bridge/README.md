# Black Cat Marketplace Bridge

Local, unpacked Chrome extension. No subscription, marketplace API key, cookie
export, debugger attachment or additional dependency is needed.

This extension is for gathering information only, as requested by the operator.
It connects Black Cat to already-open marketplace tabs. It can open the
four seller pages and inspect visible listing controls after sign-in. It does not
publish, edit or delist listings. Uploading remains in Black Cat's browser worker.
An accessible page is not proof of posting or of the worker's saved-session access.

## Install

1. In the Chrome profile you normally use for selling, open `chrome://extensions`.
2. In Black Cat Settings, choose **Open extension folder**. In Chrome, turn on
   **Developer mode**, choose **Load unpacked**, and select that folder.
3. Keep Black Cat running. Click the extension's **Connect Black Cat** toolbar
   action, or open `http://127.0.0.1:41999/browser-link` in that same Chrome profile.
4. Choose **Connect this browser**, then open or inspect a marketplace tab.

Keep the connection tab open while using the bridge. Finish sign-in yourself in
the marketplace tab. The extension only accepts requests from the exact local
connection page; it has access only to the four listed marketplace domains.
It does not request cookies, browser history, saved passwords or debugger access.
Its inspector excludes login/verification pages, hidden fields and order rows.
Results remain in the local app's memory until disconnected or restarted.

After updating these extension files, use **Reload** on its Chrome extensions
card and refresh the connection tab. Remove the extension there to uninstall.


## Connect and disconnect

Black Cat Settings includes **Connect / disconnect widget** to open the connection
page and **Enable / disable widget in Chrome** to open Chrome extension settings.
The page's **Disconnect and clear information** clears the saved inspections even
if this page has not connected yet. It does not disable the installed extension;
use the extension's toggle in Chrome settings for that. Chrome owns that toggle.

The separate **Connect Chrome** and **Disconnect Chrome** controls manage the
shared browser-automation connection. Automatic sales/removals do not need this
inspection extension. Shared Chrome work stays paused after disconnection until
reconnected or Black Cat restarts; personal Chrome tabs remain open.
