import { NextRequest, NextResponse } from "next/server";

const controlAPIURL = (process.env.CONTROL_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function POST(request: NextRequest) {
  try {
    const upstream = await fetch(`${controlAPIURL}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      cache: "no-store",
    });

    const payload = (await upstream.json()) as Record<string, unknown>;
    const publicLiveKitURL = process.env.LIVEKIT_PUBLIC_URL?.trim();

    if (upstream.ok) {
      const hostname = requestHostname(request);
      if (isLocalNetworkHost(hostname)) {
        const host = hostname.includes(":") ? `[${hostname}]` : hostname;
        payload.url = `${request.nextUrl.protocol === "https:" ? "wss" : "ws"}://${host}:7880`;
      } else if (publicLiveKitURL) {
        payload.url = publicLiveKitURL;
      }
    }

    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    console.error("token proxy failed", error);
    return NextResponse.json(
      { error: "ติดต่อ Control API ไม่ได้ กรุณาตรวจสอบว่า Go backend ทำงานอยู่ที่พอร์ต 8080" },
      { status: 502 },
    );
  }
}

function requestHostname(request: NextRequest) {
  const host = request.headers.get("host")?.trim();
  if (!host) return request.nextUrl.hostname;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return request.nextUrl.hostname;
  }
}

function isLocalNetworkHost(hostname: string) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 127;
}
