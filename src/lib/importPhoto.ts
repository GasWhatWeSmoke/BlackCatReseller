import fs from "node:fs/promises";
import path from "node:path";

/** File.name is untrusted multipart input, not a path. Check both separator
 * conventions regardless of the host OS, including Windows devices and streams. */
export function validImportPhotoName(name: string): boolean {
  return !!name && name === path.win32.basename(name) && name === path.posix.basename(name) &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) && /\.jpe?g$/i.test(name);
}

/** Exclusive creation makes simultaneous uploads with the same camera filename
 * keep both files. Never overwrite an existing file, directory, or symlink. */
export async function writeIncomingPhoto(folder: string, name: string, bytes: Uint8Array): Promise<string> {
  if (!path.isAbsolute(folder) || !validImportPhotoName(name)) throw new Error("Choose a JPEG with a plain filename.");
  await fs.mkdir(folder, { recursive: true });
  const root = await fs.realpath(folder);
  const ext = path.extname(name), stem = path.basename(name, ext);
  for (let suffix = 0; ; suffix++) {
    const destination = path.join(root, suffix ? `${stem}__${suffix}${ext}` : name);
    if (path.dirname(destination) !== root) throw new Error("Photo destination is outside the incoming folder.");
    let file;
    try { file = await fs.open(destination, "wx"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    let owned;
    try {
      owned = await file.stat();
      await file.writeFile(bytes);
      await file.close();
      return destination;
    } catch (error) {
      await file.close().catch(() => {});
      // Clean only the exact file this call created, never a replaced path.
      const current = await fs.lstat(destination).catch(() => null);
      if (owned && current?.isFile() && current.ino === owned.ino && current.dev === owned.dev && current.birthtimeMs === owned.birthtimeMs)
        await fs.unlink(destination).catch(() => {});
      throw error;
    }
  }
}
