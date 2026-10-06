import Link from 'next/link';
import styles from './StarterTutorial.module.css';

export function StarterTutorial() {
  return <section className={`card ${styles.panel}`} aria-labelledby="tutorial-heading">
    <h2 id="tutorial-heading">Your first batch, step by step</h2>
    <p>You can organize photos and review inventory locally with AI off. Browser crosslisting additionally needs your selling accounts, Google Chrome and a second monitor. Keep Auto Run off until you have checked your first batch.</p>
    <details open><summary>1. Prepare your workspace</summary>
      <ol><li>Finish photo-worker setup below. Open <Link href="/settings">Settings</Link>, expand Folders, and check the saved paths. The default folders are suitable for starting.</li>
        <li>Keep camera originals in a separate source folder. Dashboard → Upload folder copies JPEG files into Incoming and then processes them. Incoming is a working queue, so do not use your only copy of the camera folder as Incoming.</li>
        <li>Check backup status and available disk space. Originals, working images, prepared exports and backups all use storage.</li>
        <li>Leave AI Vision off if its optional local runtime is unavailable. You will enter garment details manually. Review everything even when AI is enabled.</li>
        <li>For optional NVIDIA garment AI, quit Black Cat and run <b>Setup Optional Local AI.cmd</b> beside the program. Find the program folder through your Windows shortcut’s Open file location command. Allow several GB for downloads, then reopen Black Cat and check AI status before enabling it.</li></ol>
    </details>
    <details><summary>2. Photograph each garment, then its SKU marker</summary>
      <p>A SKU is your unique inventory number. With the default settings, use six digits, such as <code>000001</code>. A QR label encoding <code>BC-000001</code> also works. Use unused numbers and match any customized SKU settings.</p>
      <p><a href="/beta-labels.html" download="BETA-TEN-LABELS.html">Download ten printable starter labels</a> (BC-000001–BC-000010). Open the saved HTML file in your browser and press Ctrl+P. Use these only with a new empty inventory or after checking that all ten SKUs are unused; otherwise use your own labels with unused numbers.</p>
      <p>Print at 100% scale on plain white paper and keep the white border around each QR code. Keep QR edges clear, in focus and free from glare. The marker must be its own last photo for that garment.</p>
      <ol><li>Take at least three clear garment photos: front, back, and label/detail. Include separate photos of brand/size/care tags, measurements and any flaws.</li>
        <li>Photograph that garment's SKU marker last. Repeat the garment photos → marker sequence for the next piece.</li>
        <li>Use JPEG (.jpg/.jpeg) files and preserve capture order. Export phone HEIC images as JPEG before import. Check all garment groups afterward, especially missing or unreadable markers.</li></ol>
    </details>
    <details><summary>3. Import and review</summary>
      <ol><li>On Dashboard, choose <b>Upload folder</b> or drop the JPEGs. Wait for copying and processing to finish. If photos were already imported, choose <b>Process them now</b>.</li>
        <li>Open <b>Inventory → Review</b>. Match each SKU to the physical garment and inspect all photos. The SKU-marker image stays internal and is excluded from listing photos.</li>
        <li>Correct brand, item type, department, color, platform-specific size, condition, price, shipping weight and copy. Do not claim material, age or authenticity without evidence.</li>
        <li>Repair grouping before approval. In the item editor, select photos and use Split or Move photos if needed; Edit SKU corrects a missing or wrong number. Check the result again.</li>
        <li>Approve only after checking the item. Bulk approval requires individual review first. Saving a complete item in the full editor can also make it Ready, so keep Auto Run off during your first test.</li></ol>
    </details>
    <details><summary>4. Connect accounts when you are ready to crosslist</summary>
      <ol><li>Connect a second monitor. Black Cat opens marketplace work windows there in the background; browser tasks wait if it is unavailable.</li>
        <li>For eBay, Etsy and Mercari, open <b>Settings → Chrome connection → First-time Chrome setup</b>. Follow its remote-debugging instructions, choose Connect Chrome, and approve Chrome's own Allow prompt.</li>
        <li>In <b>Marketplace accounts</b>, enable only the platforms you intend to use and connect each account. Sign in yourself, close the login window when finished, and confirm the sign-in in Black Cat. Depop and Poshmark use their linked account windows.</li>
        <li>Check shipping/return/payment policies, addresses, fees and publishing preferences for your accounts. The optional Chrome widget is for inspection and is separate from account sign-in.</li>
        <li>In <b>Crosslisting</b>, select actual reviewed stock and marketplaces, inspect warnings, then confirm the run. Verify the live item URL, photos, price, category, department, size and color. An uncertain result needs inspection before a retry.</li></ol>
    </details>
    <details><summary>5. Sales, backups and updates</summary>
      <p>Use Sales for orders, shipping or pickup and removal recovery. Automatic checks need the app open and the computer awake. Closing the app window to the tray pauses automatic sale checks; minimizing leaves it available. For updates, use the tray's Quit action and preserve your data folders.</p>
      <p>Before sharing diagnostics, remove account, customer and personal information. Report the exact screen, SKU, marketplace and error. Share only relevant reviewed logs.</p>
    </details>
  </section>;
}

export function RealBatchChecklist() {
  return <section id="real-batch" className={`card ${styles.panel}`} aria-labelledby="real-batch-heading">
    <h2 id="real-batch-heading">Then test ten real garments</h2>
    <p>This optional pilot checks your own Windows computer, camera files and accounts. Choose ten real garments you own and intend to sell. Use unused SKUs and keep Auto Run off. These become real inventory.</p>
    <ol><li>Record the ten SKUs and photograph each garment with at least three views plus its final marker.</li>
      <li>Import once. Count ten items and compare every photo group with the physical garments; fix grouping before approval.</li>
      <li>Review all ten individually. Record missing or incorrect suggestions and your corrections, including manual entry with AI off.</li>
      <li>Approve the reviewed items, inspect prepared photos and copy, then quit and reopen. Check that all ten items, corrections and photos remain.</li>
      <li>Check backup status. If you choose to test publishing, select only the exact real items and marketplaces you want live. Inspect each published listing independently; investigate unknown outcomes before retrying.</li>
      <li>Record Windows/app version, elapsed time, failures and whether each stage was verified. Practice completion and a successful local import do not establish marketplace success.</li></ol>
    <p className="muted">The download includes BETA-TEN-ITEMS.md with a printable result table. A fresh Windows install and an update preserving this pilot inventory must also be checked before wider release.</p>
  </section>;
}
