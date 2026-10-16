# Changelog

## Unreleased

## [2.0.0-beta.9] - 2026-10-16

- Photo processing continues when navigating away from the Dashboard. Saved job
  status, source manifests and checkpoints support explicit recovery after restart.
- Text-only inventory stickers are checked independently of QR detection. Item
  boundaries require BC- plus exactly six digits; uncertain or oversized ranges
  go to review instead of creating invented SKUs or empty items. The 32-photo
  limit includes the ending marker photo.
- Batch verification shows original photo order, detected final markers and
  unresolved ranges. Operator corrections create a new revision and protect
  already saved item boundaries. Verified source snapshots support safe recovery.
- Original filenames and source order metadata survive folder imports. Browser
  folder uploads now pass plain filenames separately from relative-path metadata.
- Inventory sorting applies to the complete filtered database before pagination,
  uses numeric BC SKU order, and remembers the selected sort.
- Attribute evidence separates label and garment information from inventory
  stickers and studio/ruler text. Unsupported details remain unconfirmed.
- Includes the recovered beta.4–beta.8 marketplace, Chrome, policy, withdrawal
  and local diagnostic features, with updated Next.js and image dependencies.

## [2.0.0-beta.8] - 2026-10-11

- Folder uploads and photo drops recognize the saving-items progress event. A
  successfully saved batch now shows its result instead of "invalid process
  stream event". Missing, malformed or conflicting final results still fail.
- eBay safely matches reviewed choices and verifies published titles containing
  slashes and regex punctuation. Country selectors recognize explicit USA and
  United States equivalents while preserving the reviewed source value.
- eBay category errors identify the initial or editor picker and the failed path
  step. Missing or ambiguous choices still stop for review; no category is guessed.
- Includes the beta 7 marketplace fixes, inventory removal recovery and diagnostics.

## [2.0.0-beta.7] - 2026-10-09

- Connecting eBay reads existing business policies from the signed-in Chrome
  account. Default or sole policies are saved into empty fields; existing choices
  are retained. Multiple policies without a default remain explicit choices.
- eBay Department handles equivalent form/public labels and rechecks menus rebuilt by
  item suggestions. Policy selection retains exact names and ignores display counts.
- Settings now offers bounded local diagnostics and an export file with recent
  actions, native/setup errors, reviewed listing fields and posting outcomes.
  Collection can be disabled. Nothing is sent automatically; exports omit photos,
  browser profiles, cookies and database files and redact credential/path details.
- Inventory items have Marketplace links for confirming a listing removed outside
  Black Cat. Unsold items can be resolved and deleted after a fresh confirmation;
  other live listings, pending work and legacy Nifty records stay protected.
  Confirmed withdrawals are held out of automatic reposting.
- Includes the Depop brand/color fallbacks and Chrome-window preservation fixes.

## [2.0.0-beta.6] - 2026-10-09

- Depop color selection uses the actual dropdown palette: exact colors first,
  then explicit shade aliases and standard families such as Light blue to Blue,
  Dark green to Green, and Charcoal to Grey. Original item details stay unchanged.
- Primary and secondary shades that resolve to the same native color select one
  chip. Unrelated inferred colors are removed and the final selection is verified.
- Includes automatic Depop brand fallback and the Chrome-window preservation fix.

## [2.0.0-beta.5] - 2026-10-09

- Depop automatically selects its Other or Unknown brand option when the item's
  brand or explicit alias is unavailable in its catalog.
  The reviewed brand, title and description remain unchanged.
- Removed the per-brand approval form from Depop settings. Native option
  selection and publication confirmation are still required.
- Includes the beta 4 fix that preserves other Chrome windows during work.

## [2.0.0-beta.4] - 2026-10-09

- Marketplace cleanup closes only the work target it created. Other Chrome
  windows and their unsaved work remain open, including cleanup failures.
- Subsequent jobs can reuse the dedicated browser after verifying its saved
  profile, browser socket and process identity.
- Posting, removal and sales-scan timeouts stop the worker without terminating
  its Chrome descendants. Existing publication-verification guards remain active.

## [2.0.0-beta.3] - 2026-10-06

- First public Windows installer release on GitHub, with checksums, setup guidance
  and instructions for later updates.
- The installer includes the MIT license, copyright Nickolas Verdugo. Third-party
  software keeps its original notices and licenses.
- Public setup, contribution, bug-report, security-reporting and release instructions.
- Official download links for first installation and later manual updates: finish
  work, choose tray Quit, then run the newer installer with the same Windows account.

## [2.0.0-beta.2]

- Windows beta with inventory, photo review, crosslisting, and sales workflows.
- Guided setup, optional local AI, and a ten-item practice workflow.
- File-delivered installer updates preserve persistent inventory, photos, settings,
  and downloaded runtimes.
- The installer waits for the user to quit the app before replacing program files.
- Recover eligible marketplace removals after transient Chrome connection failures.

Previously supplied private beta 2 installers predate the MIT license change.
Beta 3 is the first public installer containing the MIT license.
