import { NextRequest, NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type");
    if (!contentType?.startsWith("multipart/form-data")) {
      return NextResponse.json({ error: "multipart upload required" }, { status: 400 });
    }
    const upstream = await fetch(`${controlAPIURL}/api/assets`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: await request.arrayBuffer(),
      cache: "no-store",
    });
    const payload = await upstream.json();
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    console.error("asset upload proxy failed", error);
    return NextResponse.json({ error: "อัปโหลด Asset ไม่สำเร็จ" }, { status: 502 });
  }
}
