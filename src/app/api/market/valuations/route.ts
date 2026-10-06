import { NextResponse } from "next/server";
const retired = () => NextResponse.json({ error: "This research tool has been retired." }, { status: 410 });
export { retired as GET, retired as POST, retired as PATCH, retired as DELETE };
