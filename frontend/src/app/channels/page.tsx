"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createBroadcastRoom, listBroadcastRooms, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/card";
import { Toast } from "@/components/ui/toast";
import { Copy, MonitorPlay, Video, Mic, Plus, RadioTower } from "lucide-react";

export default function ChannelsPage() {
  const [rooms, setRooms] = useState<BroadcastRoom[]>([]);
  const [newRoomName, setNewRoomName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState<"success" | "error" | "info">("info");

  useEffect(() => {
    void loadRooms();
  }, []);

  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    setToastMessage(message);
    setToastType(type);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 3000);
  };

  async function loadRooms() {
    try {
      const result = await listBroadcastRooms();
      setRooms(result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "โหลดห้องไม่สำเร็จ", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!newRoomName.trim()) return;
    setIsCreating(true);
    try {
      const room = await createBroadcastRoom(newRoomName.trim());
      setRooms((current) => [room, ...current]);
      setNewRoomName("");
      showToast(`สร้างห้องสำเร็จ · Room Code: ${room.code}`, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "สร้างห้องไม่สำเร็จ", "error");
    } finally {
      setIsCreating(false);
    }
  }

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    showToast(`คัดลอก Room Code: ${code} เรียบร้อยแล้ว`, "success");
  }

  return (
    <main className="shell channels-page">
      <header className="topbar">
        <Link className="brand" href="/">
          <div className="brand-dot" />
          LocalStream
        </Link>
        <span className="connection" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <RadioTower size={14} /> LOCAL ROOM DIRECTORY
        </span>
      </header>

      <section className="channels-heading">
        <div>
          <p className="eyebrow">BROADCAST ROOMS</p>
          <h1 className="h1" style={{ marginBottom: "16px" }}>สร้างห้องถ่ายทอดสด</h1>
          <p className="text-body">ระบบจะสร้าง Code สำหรับให้เครื่องกล้องและไมค์เชื่อมเข้าห้องนี้โดยตรง</p>
        </div>
        <div className="source-links">
          <Link target="_blank" href="/camera">
            <Button variant="ghost">
              <Video size={16} /> หน้ากล้อง
            </Button>
          </Link>
          <Link target="_blank" href="/microphone">
            <Button variant="ghost">
              <Mic size={16} /> หน้าไมค์
            </Button>
          </Link>
        </div>
      </section>

      <Card style={{ marginBottom: "42px" }}>
        <CardBody>
          <form onSubmit={handleCreate} style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1", minWidth: "260px" }}>
              <Input
                label="ชื่อห้อง (Room Name)"
                id="room-name"
                placeholder="เช่น ประมูลนาฬิกา รอบเย็น"
                value={newRoomName}
                onChange={(event) => setNewRoomName(event.target.value)}
                maxLength={120}
              />
            </div>
            <Button type="submit" variant="primary" disabled={isCreating || !newRoomName.trim()} isLoading={isCreating}>
              <Plus size={18} /> สร้างห้องใหม่
            </Button>
          </form>
        </CardBody>
      </Card>

      <section className="channel-list">
        {loading && <div style={{ padding: "40px", textAlign: "center", color: "var(--text-tertiary)" }}>กำลังโหลดห้อง...</div>}
        
        {!loading && rooms.length === 0 && (
          <div className="empty-rooms text-body">
            ยังไม่มีห้องถ่ายทอดสด สร้างห้องใหม่เพื่อเริ่มต้น
          </div>
        )}

        {rooms.map((room, index) => (
          <article className="channel-row" key={room.id}>
            <div className="channel-number">{(index + 1).toString().padStart(2, "0")}</div>
            <div className="channel-info">
              <span className="channel-id text-sm">{room.id}</span>
              <h2 className="h3" style={{ margin: "4px 0" }}>{room.name}</h2>
              <p className="text-sm">สร้างเมื่อ {new Date(room.createdAt).toLocaleString("th-TH")}</p>
            </div>
            
            <button className="room-code" type="button" onClick={() => copyCode(room.code)} title="กดเพื่อคัดลอก Code">
              <small>ROOM CODE</small>
              <strong style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                {room.code}
                <Copy size={16} style={{ color: "var(--text-tertiary)" }} />
              </strong>
            </button>

            <div className="channel-actions">
              <Link href={`/studio?channel=${room.id}&code=${room.code}`}>
                <Button variant="secondary">
                  <MonitorPlay size={16} /> เข้าห้อง Studio
                </Button>
              </Link>
            </div>
          </article>
        ))}
      </section>

      <Toast visible={toastVisible} message={toastMessage} type={toastType} />
    </main>
  );
}
