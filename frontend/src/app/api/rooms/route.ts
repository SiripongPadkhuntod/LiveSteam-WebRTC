import { NextRequest, NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function GET(request: NextRequest) {
  return proxyRooms(request);
}

export async function POST(request: NextRequest) {
  return proxyRooms(request);
}

async function proxyRooms(request: NextRequest) {
  try {
    const upstreamURL = new URL(`${controlAPIURL}/api/rooms`);
    upstreamURL.search = request.nextUrl.search;
    const upstream = await fetch(upstreamURL, {
      method: request.method,
      headers: request.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
    const payload = await upstream.json();
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    console.error("room proxy failed", error);
    return NextResponse.json(
      { error: "ติดต่อ Room API ไม่ได้ กรุณาตรวจสอบว่า Go backend ทำงานอยู่" },
      { status: 502 },
    );
  }
}
