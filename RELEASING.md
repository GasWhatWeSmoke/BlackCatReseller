# Shipping a Windows release

Use GitHub Releases for versioned installer downloads and update notes. The website
can link to those same downloads. A code push does not update installed apps;
testers download and run the new installer themselves.

## Prepare and verify

1. Work from the reviewed public source history in a release branch. Keep private
   development history, credentials, inventory, photos, and machine records out
   of the public repository and release assets.
2. Choose a new version. Update `package.json` and the root version fields in
   `package-lock.json`, add its `CHANGELOG.md` section, and update the README's
   installer link. Never replace an existing version with different installer bytes.
3. Run the complete `npm.cmd test` suite and `npm.cmd run build:next` before
   committing. Use an isolated empty template database and preview mode for build
   checks. Do not build in the checkout serving someone's working inventory.
4. Review the staged diff, commit the release preparation, then run
   `npm.cmd run release` from the clean committed checkout. It builds with isolated
   data, verifies the packaged payload and empty database template, and writes
   installer/ZIP hashes and a release manifest under `dist/`.
5. Verify the packaged version, MIT `LICENSE.txt`, and `THIRD_PARTY_NOTICES.txt`.
   Keep `appId: com.blackcat.agent`, per-user installation, persistent data/runtime
   folders, and the installer guard that refuses a running app.
6. Run the packaged upgrade acceptance against the previous and new `win-unpacked`
   folders using synthetic data:

   ```powershell
   .\worker\.venv\Scripts\python.exe tests\workflow\windows-beta.py --artifact '<previous win-unpacked>' --updated-artifact '<new win-unpacked>' --check-installer-guard
   .\worker\.venv\Scripts\python.exe tests\workflow\windows-beta.py --artifact '<previous win-unpacked>' --updated-artifact '<new win-unpacked>' --check-installer-guard --run
   ```

   The first command prints the plan; the second runs it. It checks packaged
   startup, practice, restart, preservation of synthetic inventory/photos/settings
   and runtime data, and the exact NSIS guard. It does not execute the real installer
   or certify installation on a clean Windows computer. Verify the new packaged
   version separately on a fresh empty fixture, and record tester-PC results.

## Publish and deliver

1. Push only the reviewed public source commit. Create a version tag such as
   `v2.0.0-beta.3` pointing to that exact commit.
2. Create a **draft** GitHub release for the tag. Mark beta versions as a
   **pre-release**. Add concise change notes, first-install/update instructions,
   known limitations, and links to the setup and ten-garment guides.
3. Attach the tested `BlackCatReseller-v<version>-Setup.exe`, its matching
   `SHA256SUMS.txt`, and `UPDATE-INSTRUCTIONS.txt`. Keep logs, private delivery
   records, runtime binaries other than the reviewed installer, and test databases
   out of the release assets.
4. Verify the uploaded asset names, sizes, and SHA-256 digests before publishing.
   After publishing, download the installer through its public asset URL and check
   that its hash matches the tested local file.
5. Send the tester the direct installer URL and the release page for future updates.
   They finish work, choose tray **Quit**, and run Setup using the same Windows
   account. They keep existing data folders and do not uninstall first.

Use `https://github.com/GasWhatWeSmoke/BlackCatReseller/releases` as the permanent
download/update page. A website Download button can point to the current version's
installer URL. Update that button when shipping a new version. Beta pre-releases
do not use GitHub's `releases/latest` shortcut; link to the explicit beta tag.
