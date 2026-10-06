# Black Cat Reseller — Windows beta setup

Black Cat manages clothing inventory, photos, review, browser crosslisting and
sales locally on your Windows PC. This is a private beta for testing. A successful
practice exercise does not establish that your camera, AI or marketplaces work.
Use [the ten-garment checklist](BETA-TEN-ITEMS.md) to record those results separately.

## Before starting

- Use a Windows 64-bit PC and a writable installation folder. Allow storage for
  original photographs, working/export copies, backups and first-time downloads.
- This beta download is unsigned. Check the supplied SHA256SUMS.txt and its source;
  if your Windows security policy blocks it, report that result instead of disabling
  antivirus or changing your computer's security settings.
- Internet access is needed for worker setup and marketplace actions. Install
  Google Chrome and connect a second monitor before browser crosslisting; owned
  marketplace windows open on that monitor in the background.
- Use your own selling accounts and sign in yourself. Inventory and manual review
  are usable before connecting accounts. Keep **Auto Run off** for the first batch.
- Local garment AI is optional. It needs a compatible NVIDIA GPU and separately
  installed model/runtime files. Leave **AI Vision off** if unavailable and enter
  garment details manually. OCR/tag reading also needs its model files; first use
  can require downloads even after the Python packages have installed.

## Install and open

1. For an installer, run **BlackCatReseller-v<version>-Setup.exe**. It installs
   for your Windows account and opens Black Cat; use its shortcut afterward.
   For an unpacked ZIP, extract the complete folder to a
   writable location and run **Black Cat Reseller.exe**. Keep `resources` beside it.
2. Open **Getting started** from the Dashboard banner or **Settings → Getting
   started**. Read the tutorial and use **Install photo worker**. Setup downloads
   private Python, photo tools and browser files; keep the app open while it runs.
   A setup error needs attention before proceeding. Use **Check setup status**
   and **Retry worker setup** after resolving it.
3. If this build does not expose the setup control, run **Setup Black Cat
   Agent.cmd** beside the executable, wait for success, then return to the guide
   and choose **Re-check installation**. Do not run both setup methods at once.
4. Fresh packaged data defaults to `C:\Users\<you>\BlackCatAgent\`. Existing saved
   paths take precedence. In **Settings → Folders**, inspect the saved paths before
   importing. Defaults are suitable for starting; changing paths does not move
   existing inventory automatically.
5. Check backup status and free disk space. Keep originals in a separate camera
   source folder. **Incoming is a working queue**, not your only photo archive.

Photo tools and browser files are stored under your data folder's `runtime` directory
(normally `C:\Users\<you>\BlackCatAgent\var\runtime`), outside the application folder.
They survive application replacement. Existing custom Python paths remain your choice.

## Optional local garment AI

Manual inventory and review work without a GPU or garment model. If you have a
compatible NVIDIA GPU and want local suggestions, use **Setup Optional Local AI.cmd**
beside the program. It downloads approximately 3.9 GB of pinned runtime/model assets;
allow additional space for extraction and working files. Quit Black Cat through its
tray menu first, keep the setup window open, then reopen the app after success.
The default asset folder is `var\runtime\vision` under your persistent data folder.
Check AI status before enabling it, and record accuracy on your ten real garments.
Hardware/model availability and a completed installation do not prove recognition
accuracy. Website downloads and weekly update installation do not automatically
download or enable this optional model.

The checklist verifies the worker's photo tools and required setup record, then
reports saved choices and other local observations. Verify a real photo batch next.
The checklist includes marketplace setup and a first listing, so it can remain
incomplete while you use the local inventory workflow. Skip eBay policy setup
when you are not using eBay.

## Try the tutorial

Choose **Try practice batch** in Getting started. Review ten fictional garments,
compare the reference cards and sample views, correct the three planted mistakes
or missing fields, and finish each individual review.

Practice is a simulation held only on that page. It creates no inventory, uses no
accounts or AI, and cannot publish. Leaving, reloading or ending practice resets
it. It teaches review habits; it does not test photo processing, recognition,
marketplace forms or your Windows installation.

## Photograph and process ten real garments

1. Assign unused inventory numbers. Default SKU labels use six digits, such as
   `000001`; QR labels encoding `BC-000001` also work. In the tutorial, choose
   **Download ten printable starter labels** (`/beta-labels.html`), or open the
   supplied **BETA-TEN-LABELS.html** in your browser. Press **Ctrl+P**, choose plain
   white paper and 100% scale, and keep the white QR borders when cutting cards.
   These encode **BC-000001–BC-000010**. Use them only with a new empty inventory
   or after checking all ten numbers are unused. Otherwise use your own QR labels
   with unused numbers. Match any customized SKU settings.
2. Photograph each garment: at least three clear views, including front, back and
   label/detail. Add brand/size/care tags, measurements and flaws as appropriate.
3. Photograph that garment's SKU marker as its own **last image**. Then start the
   next garment. Keep QR edges clear, sharp and free from glare. Preserve capture
   order; missing or unreadable markers can join the wrong photographs together.
4. Use JPEG `.jpg`/`.jpeg` files. Export HEIC phone images as JPEG first. On
   **Dashboard**, choose **Upload folder** or drop the JPEGs. The app copies and
   processes them. **Process them now** resumes files already waiting in Incoming.
5. Open **Inventory → Review**. Check there are ten items and match each SKU and
   photograph to its garment. Marker images stay internal and are excluded from
   listing photos. Repair grouping before approval: the editor offers **Edit SKU**,
   **Split** and **Move photos** for explicit corrections.
6. Inspect and correct brand, item type, department, color, platform-specific size,
   condition, price, shipping weight and copy. Check measurements and label claims.
   AI suggestions and OCR matches can be wrong; do not treat confidence as proof.
7. Approve only after checking each item. Bulk approval requires individual review
   first. Saving a complete item in the full editor can also make it Ready; this
   is another reason to keep Auto Run off during the pilot.
8. Inspect prepared photos/copy, quit through the tray and reopen. Confirm all ten
   items and corrections remain. Record results in [BETA-TEN-ITEMS.md](BETA-TEN-ITEMS.md).

## Connect marketplaces and verify a real listing

1. Connect the second monitor. In **Settings → Chrome connection → First-time
   Chrome setup**, follow the remote-debugging instructions for your selling
   Chrome. Choose **Connect Chrome** and complete Chrome's own Allow prompt.
   eBay, Etsy and Mercari use this connection. The inspection widget is optional.
2. In **Marketplace accounts**, enable only the platforms you intend to use and
   connect each one. Sign in yourself, close the login window when finished, then
   confirm the sign-in in Black Cat. Depop and Poshmark use linked account windows.
3. Review account-specific publishing preferences, fees and shipping estimates.
   For eBay, choose your saved shipping, return and payment policies. Configure
   the Mercari ship-from ZIP and shipping mode when applicable. Use Etsy only for
   eligible merchandise; do not assume every used garment is eligible.
4. In **Crosslisting → Queue & Auto Run**, select the exact real garments and
   marketplaces you want live. Review warnings and confirm the batch. This creates
   real listings; do not use fake merchandise for this test.
5. Watch **Run activity**, then independently inspect each actual listing URL,
   SKU/item identity, photos, price, category, department, size and color. Use
   **Needs attention** for failures. Inspect an uncertain outcome before retrying;
   other platforms may already have published successfully.

## Sales, updates and help

Use **Sales → Orders & shipping** for fulfillment and **Insights** for earnings.
Keep the computer awake and app open for automatic sale checks/removal recovery.
Closing its window to the tray pauses automatic sale checks; minimizing alone does
not. **Sync sales** requests an extra check. Failed removal verification requires
attention and must not be treated as a completed removal.

When you receive a newer **Setup.exe**:

1. Finish photo processing, publishing or item removal and save your edits.
2. Check backup status, then choose **Quit** from Black Cat's system-tray menu.
   Closing only the window leaves the app running. Setup will ask you to quit
   before proceeding instead of stopping active work itself.
3. Run the new **Setup.exe** with the same Windows account as before. It replaces
   the installed program and opens the updated version; no uninstall is needed.

Inventory, photos, settings and downloaded photo/AI tools are kept outside the
installed program folder. Keep those data folders in place, use the existing
shortcut and check the version shown in the app afterward. First-time worker setup
does not need to be repeated unless the app reports its tools need repair.

The same file installs Black Cat for a new tester. Updates are supplied as files;
there is no online update checker. Never replace business data with a test database
or run developer reset/cleanup tools. Verify inventory, photos, drafts and account
settings on the beta tester's computer after an update.

Startup creates a fresh database from a schema template and checks additive schema
compatibility on existing installations. Inspect errors rather than assuming every
older installation has passed upgrade testing.

With default packaged paths, application logs are under
`C:\Users\<you>\BlackCatAgent\var\logs\`; saved folder settings can change that.
For setup failures, use the local log location shown by the setup control.
Report the exact screen, SKU, marketplace and error. Review relevant logs for
account/customer/personal information before sharing them; do not send your whole
data folder, credentials, browser profile or account sessions.
