import { redirect } from "next/navigation";
export default async function OldHistory({ searchParams }: { searchParams: Promise<{ view?: string }> }) { const query = await searchParams; redirect(query.view === "sold" ? "/sales" : "/ready/history"); }
