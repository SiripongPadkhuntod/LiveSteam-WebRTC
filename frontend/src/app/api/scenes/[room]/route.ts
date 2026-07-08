import { NextRequest, NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function GET(request: NextRequest, context: { params: Promise<{ room: string }> }) {
  return proxyScene(request, context);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ room: string }> }) {
  return proxyScene(request, context);
}

async function proxyScene(request: NextRequest, context: { params: Promise<{ room: string }> }) {
  try {
    const { room } = await context.params;
    const upstream = await fetch(`${controlAPIURL}/api/scenes/${encodeURIComponent(room)}`, {
      method: request.method,
      headers: request.method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: request.method === "PUT" ? await request.text() : undefined,
      cache: "no-store",
    });
    const payload = await upstream.json();
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    console.error("scene proxy failed", error);
    return NextResponse.json({ error: "ติดต่อ Scene Control API ไม่ได้" }, { status: 502 });
  }
}
