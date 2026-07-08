import { NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const upstream = await fetch(`${controlAPIURL}/api/assets/${encodeURIComponent(id)}`, { cache: "force-cache" });
    if (!upstream.ok) {
      return NextResponse.json({ error: "ไม่พบ Asset" }, { status: upstream.status });
    }
    return new NextResponse(await upstream.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("asset proxy failed", error);
    return NextResponse.json({ error: "โหลด Asset ไม่สำเร็จ" }, { status: 502 });
  }
}
