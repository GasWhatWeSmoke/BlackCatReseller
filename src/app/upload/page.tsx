import { redirect } from "next/navigation";

// The Upload tab was folded into the Dashboard (drop-anywhere + the folder button made a
// separate tab redundant). Stub kept so old links/bookmarks land somewhere sensible.
export default function UploadRedirect() {
  redirect("/");
}
