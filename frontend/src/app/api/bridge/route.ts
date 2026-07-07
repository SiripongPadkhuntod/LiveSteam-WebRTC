import { NextRequest, NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function POST(request: NextRequest) {
  try {
    const upstream = await fetch(`${controlAPIURL}/api/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      cache: "no-store",
    });
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch (error) {
    console.error("bridge proxy failed", error);
    return NextResponse.json({ error: "เริ่ม Program RTP Bridge ไม่สำเร็จ" }, { status: 502 });
  }
}
