"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createBroadcastRoom, listBroadcastRooms, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toast } from "@/components/ui/toast";
import { Copy, MonitorPlay, Video, Mic, Plus, Eye, ArrowUpRight, Clapperboard } from "lucide-react";

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <span className="channel-directory-status"><i /> LOCAL CHANNEL DIRECTORY</span>
      </header>

      <section className="channel-directory-hero">
        <div>
          <p className="eyebrow">LIVE CHANNELS</p>
          <h1>เลือก Channel<br />ที่ต้องการรับชม</h1>
          <p>เข้าชมการถ่ายทอดสดได้โดยตรง หรือเปิด Studio เพื่อควบคุมการผลิตรายการ</p>
        </div>
        <div className="channel-directory-tools">
          <span>FOR PRODUCTION TEAM</span>
          <div>
            <Link target="_blank" href="/camera"><Button variant="secondary"><Video size={16} /> กล้อง</Button></Link>
            <Link target="_blank" href="/microphone"><Button variant="secondary"><Mic size={16} /> ไมโครโฟน</Button></Link>
          </div>
        </div>
      </section>

      <section className="channel-create-card">
        <div className="channel-create-heading"><div className="channel-create-icon"><Plus size={18} /></div><span><strong>สร้าง Channel ใหม่</strong><small>ระบบจะออก Room Code สำหรับกล้องและไมโครโฟน</small></span></div>
        <form onSubmit={handleCreate} className="channel-create-form">
            <div>
              <Input
                label="ชื่อห้อง (Room Name)"
                id="room-name"
                placeholder="เช่น ประมูลนาฬิกา รอบเย็น"
                value={newRoomName}
                onChange={(event) => setNewRoomName(event.target.value)}
                maxLength={120}
                required
              />
            </div>
            <Button type="submit" variant="primary" disabled={isCreating} isLoading={isCreating}>
              <Plus size={18} /> สร้างห้องใหม่
            </Button>
        </form>
      </section>

      <section className="channel-directory-list">
        <div className="channel-directory-list-header"><span>ALL CHANNELS</span><strong>{rooms.length.toString().padStart(2, "0")} ROOMS</strong></div>
        {loading && <div className="channel-directory-empty">กำลังโหลด Channel...</div>}
        
        {!loading && rooms.length === 0 && (
          <div className="channel-directory-empty">
            ยังไม่มีห้องถ่ายทอดสด สร้างห้องใหม่เพื่อเริ่มต้น
          </div>
        )}

        {rooms.map((room, index) => (
          <article className="channel-directory-card" key={room.id}>
            <div className="channel-card-index">{(index + 1).toString().padStart(2, "0")}</div>
            <div className="channel-card-main">
              <div className="channel-card-state"><i /><span>READY TO WATCH</span></div>
              <h2>{room.name}</h2>
              <p><Clapperboard size={14} /> {room.id} <b>·</b> สร้างเมื่อ {new Date(room.createdAt).toLocaleString("th-TH")}</p>
            </div>
            <div className="channel-card-actions">
              <Link href={`/watch?channel=${encodeURIComponent(room.id)}`}>
                <Button variant="primary">
                  <Eye size={16} /> เข้าชม <ArrowUpRight size={14} />
                </Button>
              </Link>
              <Link href={`/studio?channel=${room.id}&code=${room.code}`}>
                <Button variant="ghost"><MonitorPlay size={16} /> Studio</Button>
              </Link>
            </div>
            <button className="channel-card-code" type="button" onClick={() => copyCode(room.code)} title="กดเพื่อคัดลอก Room Code"><span>ROOM CODE</span><strong>{room.code}</strong><Copy size={14} /></button>
          </article>
        ))}
      </section>

      <Toast visible={toastVisible} message={toastMessage} type={toastType} />
    </main>
  );
}
