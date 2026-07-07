export type ParticipantRole = "broadcaster" | "monitor" | "viewer";
export type MediaTarget = "source" | "d1";

export type BroadcastRoom = {
  id: string;
  name: string;
  code: string;
  studioIdentity: string;
  createdAt: string;
};

export async function getConnectionToken(
  identity: string,
  room: string,
  role: ParticipantRole,
  target: MediaTarget = "source",
) {
  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity, room, role, target }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "ไม่สามารถขอ Token ได้");
  }

  return payload as { token: string; url: string };
}

export async function createBroadcastRoom(name: string) {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return readRoomResponse(response);
}

export async function listBroadcastRooms() {
  const response = await fetch("/api/rooms", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "ไม่สามารถโหลดรายการห้องได้");
  return payload.rooms as BroadcastRoom[];
}

export async function findRoomByCode(code: string) {
  const normalized = code.trim().replaceAll("-", "").toUpperCase();
  const response = await fetch(`/api/rooms?code=${encodeURIComponent(normalized)}`, { cache: "no-store" });
  return readRoomResponse(response);
}

export async function ensureProgramBridge(room: string) {
  const response = await fetch("/api/bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "เริ่ม Program RTP Bridge ไม่สำเร็จ");
  return payload as { room: string; d1Room: string; identity: string; passthrough: boolean };
}

async function readRoomResponse(response: Response) {
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 404) throw new Error("ไม่พบห้องจาก Code นี้");
    throw new Error(payload.error ?? "ไม่สามารถดำเนินการกับห้องได้");
  }
  return payload as BroadcastRoom;
}

export function participantID(prefix: string) {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return `${prefix}-${randomUUID.call(globalThis.crypto).slice(0, 8)}`;
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
    const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${suffix}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tokenEndpoint() {
  const apiURL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  return apiURL ? `${apiURL}/api/token` : "/api/token";
}
