# Offline 100-item workflow acceptance

## Packaged Windows acceptance

`windows-beta.py` defaults to a plan only:

```powershell
.\worker\.venv\Scripts\python.exe tests\workflow\windows-beta.py --artifact "C:\path\to\win-unpacked"
```

For file-delivered updates, add `--updated-artifact "C:\path\to\new\win-unpacked"`
and `--check-installer-guard`. With the existing explicit `--run`, the fixture
launches the older and newer packaged versions against the same owned temporary
profile, checks all saved rows/photos/runtime markers, and compiles the exact NSIS
guard. That probe must refuse each running app without terminating it, then allow
the idle state. It contains no install/uninstall, registry or shortcut instructions.
The Windows installer itself and clean-OS installation remain separate acceptance.

After reviewing the artifact and plan, add `--run` to launch the actual unpacked
EXE in an owned temporary workspace. A second monitor is mandatory. The fixture
uses the private Playwright installation's bundled Node for automation; the tested
app receives a PATH containing only Windows system directories. It uses the app's
preview mode, separate database/profile/runtime paths and a high loopback port.
Visible app windows stay at normal size in the background on monitor two. DOM
activation avoids native mouse/keyboard focus; a Windows foreground monitor stops
the fixture if one of its processes takes focus.

The fixture checks first-run database/folders, version, tutorial, missing-worker
guidance and all ten fictional practice reviews. Practice must leave business
tables empty. After normal app shutdown, it seeds ten explicitly synthetic,
unapproved garments/photos into that fixture database only. It checks their UI,
all business-table hashes, photo hashes, local profile and persistent runtime
location across a restart and a second copied artifact directory. Supply
`--updated-artifact "C:\path\to\new-win-unpacked"` to test another build; without it,
the result is explicitly a relocation test of the same build.

Shutdown uses Electron's normal `app.quit`. Only the helper and its descendants
enter an owned Windows Job Object, which provides bounded cleanup on failure.
No business database, personal Chrome process, installer registry, marketplace,
worker download or local AI is used. Requests originate from the rendered UI;
there is no API-probe loop. Proof, logs, screenshots and synthetic data stay under
the printed `Temp\blackcat-windows-beta-*` artifact directory.

This runs on the development workstation. It does **not** establish clean-OS,
NSIS install/uninstall, worker-installation, real-photo intake or marketplace
acceptance. The plan reports whether Windows Sandbox is already available; it
never enables a feature, installs anything or starts a service. Run the normal
full test/build gate separately.

## Ten-item fresh-worker beta acceptance

After setup succeeds for a separately installed private worker, run:

```powershell
.\worker\.venv\Scripts\python.exe tests\workflow\ten-item-beta.py --worker-python 'C:\absolute\private-runtime\worker\.venv\Scripts\python.exe'
```

The explicitly selected interpreter generates 40 synthetic JPEGs, then runs the
actual Node/Python intake and photo-export transport. A schema-only temporary
database exercises real import, persistence, manual-field editing and approval
helpers. Assertions cover ten native QR groups, EXIF ordering, marker exclusion,
40 original/archive hashes, 30 prepared exports, and exact 40-photo reimport
without changing the item/photo snapshot. A separate 39-photo case leaves the
missing final marker as an unapproved low-confidence shell with a warning; a
four-photo repeat import remains idempotent.

The runner prints a proof/log directory under system Temp and removes its owned
temporary databases/media after the clients exit. It does not change source or
saved app settings. OCR and AI are disabled, the backup hook is substituted, and
manual garment details are supplied by the fixture. There is no application
server, route handler, marketplace adapter, real inventory or external operation.
This proves the selected worker's synthetic local pipeline, not real garment
recognition, a clean Windows installation or live marketplace compatibility.
Do not generate Prisma/build until the runner and its backends have exited.

Return confirmation acceptance: `.\worker\.venv\Scripts\python.exe tests\workflow\return-identity.py`.
Runs actual Returns components with a disposable three-sale SQLite fixture and
direct helper callbacks. Replaces the review or item during confirmation, checks
that stock remains sold, then verifies a fresh return, actual costs, keep-sale
behavior and four widths. No application server, API probes or real operations.

Manual-sale acceptance: `.\worker\.venv\Scripts\python.exe tests\workflow\manual-sale.py`.
Uses the actual Sales/form components and direct item/history helpers with five
synthetic items in an owned temporary SQLite database. Checks explicit sale
confirmation, pickup/handover, removal queuing, unsent draft refresh, lost committed
reply recovery without replay, stale selection, denied/corrupt local storage,
and confirmation layout/focus at 1320/768/390/320. Browser fetches are intercepted
into local callbacks; no application server, API probes or marketplace operations.
Proof/screenshots remain outside the repo. The backend is closed after acceptance.

Archive/restore acceptance: `.\worker\.venv\Scripts\python.exe tests\workflow\archive.py`.
Uses the actual Inventory component and item-save helper with an owned empty
SQLite fixture, 100 synthetic items and original image files. Covers confirmations,
95 eligible/five protected outcomes, Restore to Review, stale revisions, stopping,
lost responses, refresh without replay, storage failures and corrupt reports.
Source files, photo rows, marketplace rows and jobs are checked for preservation.
Four-width dialogs and visible focus are checked. All transport is intercepted
into local functions; no app server, route handler, API check or real inventory
action occurs. Artifacts remain in a private temporary directory.


Marketplace-preference recovery acceptance:
`.\worker\.venv\Scripts\python.exe tests\workflow\marketplace-drafts.py` renders
the actual eBay, Etsy, Mercari and Depop/Mercari brand forms with real IndexedDB.
Synthetic server replies cover independent drafts, explicit Save, normalized
receipts, concurrent windows, changed preferences/workspaces, blocked/corrupt/full
storage and browser restart. Posting/promotion/renewal changes remain unapplied
until Save. The fixture does not start an app server, call real accounts or use an
API-check harness. The separate SQLite tests exercise the actual transactional
comparison used by the existing settings handler.

Settings recovery acceptance:
`.\worker\.venv\Scripts\python.exe tests\workflow\settings-draft.py` renders the
actual general-preferences form with real browser IndexedDB. Account, browser and
maintenance companion panels are inert; settings reads/saves use a synthetic
in-memory binding. It covers reload/navigation/process restart, pending and failed
saves, a lost success response, changed saved values, competing windows, blocked
storage, corrupt records, quota failures and preservation of item-review drafts.
Screenshots cover four widths from 1320 to 320 pixels. No app server, API check,
real settings mutation or external request is involved.

Dashboard appearance acceptance is also available with
`.\worker\.venv\Scripts\python.exe tests\workflow\appearance.py`. It renders the actual Dashboard,
navigation and motion component against synthetic read-only data at 1440, 1320,
1024, 768, 390 and 320 pixels. Screenshots and proof go to a temporary directory.
Checks cover overflow, visible accounting caveats and recovery warnings, keyboard
focus, reduced motion and the explicit motion-off preference. Every request is
intercepted inside the browser; it does not start an app server or inspect APIs.

Photo fitting acceptance:
`.\worker\.venv\Scripts\python.exe tests\workflow\photo-fit.py` renders the actual
Review photo controls and full-size viewer with marked landscape, portrait and
square fixtures. All four corners must remain visible at every saved orientation
at 900, 390 and 320 pixels. It also checks retry, fit/100% zoom, photo navigation
and focus return. Images are generated in memory and intercepted locally. No
inventory records, real photos or marketplace accounts are changed. The main
100-item workflow also checks rotated photo containment in Review, the editor
and Inventory at its five widths.

From the repository root on the supported Windows development workstation:

```powershell
.\worker\.venv\Scripts\python.exe tests\workflow\run.py
```

Uses the existing Node, Python, Playwright, Chrome and image-export dependencies.
No package installation, app server, route handler, API check or external request
is needed. It prints an artifact directory under the system temporary directory;
that directory holds the proof, logs and screenshots. Databases, photos and browser
profiles are separate owned temporary fixtures and are removed after the run.

The actual Review, batch approval, Crosslisting, recovery, Sales, Insights and
Inventory components run with their requests connected to local functions through
a private test binding. The backend uses real photo import and the Node/Python intake
transport, QR decoding, grouping, thumbnails, SQLite, item-save logic, persistence,
photo export, publishing queue, retry/uncertainty guards, sale protection and earnings.
No database or settings are copied back into the working app.

Coverage includes:

- 400 generated 900×1200 camera JPEGs: three garment views and one QR marker per
  item, copied through `writeIncomingPhoto`. EXIF time deliberately opposes filename
  order. The actual worker must decode all 100 markers and group every photo into
  its independently recorded SKU, retaining hashes and creating listing thumbnails.
- Marker exclusion from listing photos, 400 preserved camera/archive originals,
  and 300 prepared listing exports. A four-photo exact reimport must create no new
  item, preserve the complete item/photo snapshot and consume the incoming copies.
- Package estimates visible in Review, Editor and all 100 Ready rows, live draft
  changes/clear-to-estimate, no writes from viewing, and five-width queue layouts.
- Individual review, an AI-field correction, photo rotation, draft reload and the
  exclusion of an unreviewed item from bulk approval.
- Review checkpoints surviving process/browser restart, 100 batch approvals and
  independent prepared-file identity/hash/rotation assertions.
- Publishing pause/resume across restart, partial failures, a safe target retry,
  and an unknown outcome that cannot be retried automatically.
- A Poshmark sale, uncertain then verified removal of its eBay/Depop counterparts,
  cost entry, fixture earnings, shipping completion, receipt replay and search.

Boundaries: photos and recognition replies are synthetic. Native intake runs with
OCR disabled and forced no-AI admission. After its real validated receipt is checked,
the fixture supplies synthetic recognition fields for the subsequent correction and
approval workflow. This does not prove live-model accuracy, damaged/glare-hit sticker
recovery, real-phone-photo throughput, marketplace sessions/forms or physical fulfillment.
Marketplace adapter results and removal observations are simulated; no test
merchandise is published. The persistence backup hook is substituted. Real
`BLACKCAT_PREVIEW=1` remains enabled; only the isolated queue module receives a
test process view allowing its loop with fake adapters. New unexpected dependencies
or UI operations fail the harness instead of falling through to production work.
The worker spawn wrapper adds `windowsHide: true` for the owned fixture process;
worker behavior and protocol validation use the real application functions.

Timings describe this automated fixture, not human throughput or live marketplace
performance. Do not run Prisma generation or a build while the fixture owns the
worktree's Prisma library. Run the normal full suite and production build separately.


## Daily appearance

Run `worker\.venv\Scripts\python.exe tests\workflow\daily-theme.py` for the actual
Appearance controls and shared shell with local storage and a controlled New York
clock. It checks five widths, saved colors, per-day editing/reset, preview isolation,
night and midnight updates, wake recovery, manual brightness, cross-window changes,
and storage failures. It also checks background drift without input, saved still
mode, and hidden-window, Motion off and reduced-motion pauses. All browser requests
are intercepted; no server or business
database is used. Screenshots and proof are written under the system Temp folder.
The existing `appearance.py` also renders the daily theme on the Dashboard.

## Abnormal intake and restart

Run separately from the normal lifecycle and required suite:

```powershell
.\worker\.venv\Scripts\python.exe tests\workflow\intake_cases.py
```

This uses the same private backend with an empty temporary database and generated
camera files. It verifies a named corrupt JPEG stops before mutation, cooperative
cancellation preserves all incoming hashes and empty inventory, and a restarted
backend resumes a 50-item batch with a missing final marker. The missing-marker
group stays a low-confidence shell awaiting review. It checks all original/archive
hashes, no automatic approval, no marketplace jobs/calls, and an exact four-photo
reimport that creates no duplicates or item/photo changes.

No-AI admission may finish before the cancellation request is observed. The
terminal result must still be cancelled, the request must be accepted, and every
file/database preservation assertion must pass. This timing allowance does not
permit partial mutation. OCR and garment recognition are disabled; these synthetic
fixtures do not establish live-model accuracy or real-camera throughput. The
backup hook is substituted. The runner records proof/backend diagnostics in an
owned temporary artifact directory and closes its backend before fixture cleanup.
