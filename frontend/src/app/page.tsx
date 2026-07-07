import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Video, Mic, LayoutDashboard, MonitorPlay, Zap, ArrowRight, Layers } from "lucide-react";

export default function Home() {
  return (
    <main className="landing shell" style={{ paddingBottom: "120px" }}>
      <header className="topbar" style={{ padding: "24px 0", borderBottom: "none" }}>
        <div className="brand">
          <div className="brand-dot" />
          LocalStream
        </div>
      </header>
      
      <section className="hero" style={{ paddingTop: "80px", paddingBottom: "80px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Badge variant="default" style={{ marginBottom: "24px", padding: "6px 16px" }}>
          <Zap size={14} style={{ color: "var(--brand-accent)" }} /> WebRTC v1.0
        </Badge>
        <h1 className="h1" style={{ fontSize: "clamp(48px, 6vw, 72px)", letterSpacing: "-0.04em", lineHeight: 1.1, maxWidth: "800px" }}>
          ถ่ายทอดสดแบบเรียลไทม์<br />
          <span style={{ color: "var(--brand-accent)" }}>จากกล้องและไมค์ไร้สาย</span>
        </h1>
        <p className="hero-copy text-body" style={{ marginTop: "24px", maxWidth: "600px", fontSize: "18px", color: "var(--text-secondary)" }}>
          ควบคุมภาพจาก Broadcast Studio และตรวจสอบ Program Output ที่ผู้ชมได้รับจริงผ่าน LiveKit SFU ด้วยความหน่วงระดับ Ultra-Low Latency
        </p>
        <div className="hero-actions" style={{ marginTop: "40px", display: "flex", gap: "16px", flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/channels">
            <Button size="lg" variant="primary" style={{ height: "56px", padding: "0 32px", fontSize: "16px" }}>
              <LayoutDashboard size={20} />
              ไปที่ Dashboard จัดการห้อง
              <ArrowRight size={18} style={{ marginLeft: "4px" }} />
            </Button>
          </Link>
          <Link href="/camera">
            <Button size="lg" variant="secondary" style={{ height: "56px", padding: "0 24px" }}>
              <Video size={20} />
              เชื่อมต่อกล้อง
            </Button>
          </Link>
          <Link href="/microphone">
            <Button size="lg" variant="secondary" style={{ height: "56px", padding: "0 24px" }}>
              <Mic size={20} />
              เชื่อมต่อไมค์
            </Button>
          </Link>
        </div>
      </section>
      
      <section className="feature-grid" style={{ marginTop: "40px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>
        <Card style={{ transition: "transform 0.2s, box-shadow 0.2s", cursor: "default" }}>
          <CardBody style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(255, 62, 0, 0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand-accent)" }}>
              <Layers size={24} />
            </div>
            <div>
              <h2 className="h3" style={{ margin: "0 0 8px" }}>Multiple Sources</h2>
              <p className="text-body" style={{ color: "var(--text-secondary)", margin: 0 }}>ดู Preview ทั้งกล้องและไมโครโฟนได้ไม่จำกัดพร้อมกันในหน้าจอเดียว</p>
            </div>
          </CardBody>
        </Card>
        <Card style={{ transition: "transform 0.2s, box-shadow 0.2s", cursor: "default" }}>
          <CardBody style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(255, 62, 0, 0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand-accent)" }}>
              <MonitorPlay size={24} />
            </div>
            <div>
              <h2 className="h3" style={{ margin: "0 0 8px" }}>Program Output</h2>
              <p className="text-body" style={{ color: "var(--text-secondary)", margin: 0 }}>Monitor ภาพและเสียงที่วิ่งย้อนกลับผ่าน SFU เพื่อตรวจสอบสิ่งที่คนดูได้รับจริง</p>
            </div>
          </CardBody>
        </Card>
        <Card style={{ transition: "transform 0.2s, box-shadow 0.2s", cursor: "default" }}>
          <CardBody style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(255, 62, 0, 0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--brand-accent)" }}>
              <Zap size={24} />
            </div>
            <div>
              <h2 className="h3" style={{ margin: "0 0 8px" }}>Ultra Low Latency</h2>
              <p className="text-body" style={{ color: "var(--text-secondary)", margin: 0 }}>สลับ source บน Track หลักแบบไดนามิกโดยไม่ต้อง Reconnect ใหม่</p>
            </div>
          </CardBody>
        </Card>
      </section>
    </main>
  );
}
