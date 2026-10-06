import { redirect } from "next/navigation";

// Legacy route (/batches -> /upload -> Dashboard). Intake lives on the Dashboard now.
export default function BatchesRedirect() {
  redirect("/");
}
