import { NextResponse } from "next/server";
const retired = () => NextResponse.json({ error: "This upload route has been retired. Use Crosslisting." }, { status: 410 });
export { retired as GET, retired as POST, retired as PATCH };
