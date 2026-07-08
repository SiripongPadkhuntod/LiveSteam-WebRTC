"use client";

import { useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, EyeOff, ImagePlus, Layers3, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadSceneAsset } from "@/lib/api";
import type { SceneImageLayer } from "@/lib/scene";

type DragState = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  layer: SceneImageLayer;
};

export function SceneOverlay({
  layers,
  selectedID,
  disabled,
  onSelect,
  onChange,
}: {
  layers: SceneImageLayer[];
  selectedID: string | null;
  disabled?: boolean;
  onSelect: (id: string | null) => void;
  onChange: (layers: SceneImageLayer[]) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>, layer: SceneImageLayer, mode: DragState["mode"]) {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: layer.id, mode, startX: event.clientX, startY: event.clientY, layer: { ...layer } };
    onSelect(layer.id);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!drag || !bounds) return;
    const dx = ((event.clientX - drag.startX) / bounds.width) * 100;
    const dy = ((event.clientY - drag.startY) / bounds.height) * 100;
    onChange(layers.map((layer) => {
      if (layer.id !== drag.id) return layer;
      if (drag.mode === "move") {
        return {
          ...layer,
          x: clamp(drag.layer.x + dx, 0, 100 - layer.width),
          y: clamp(drag.layer.y + dy, 0, 100 - layer.height),
        };
      }
      return {
        ...layer,
        width: clamp(drag.layer.width + dx, 5, 100 - layer.x),
        height: clamp(drag.layer.height + dy, 5, 100 - layer.y),
      };
    }));
  }

  return (
    <div
      ref={overlayRef}
      className="scene-overlay"
      onPointerDown={() => !disabled && onSelect(null)}
    >
      {layers.filter((layer) => layer.visible).map((layer) => (
        <div
          key={layer.id}
          className={`scene-image-layer ${selectedID === layer.id ? "selected" : ""}`}
          style={{
            left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`,
            opacity: layer.opacity, zIndex: layer.zIndex,
          }}
          onPointerDown={(event) => startDrag(event, layer, "move")}
          onPointerMove={moveDrag}
          onPointerUp={() => { dragRef.current = null; }}
          title={layer.name}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={layer.src} alt={layer.name} draggable={false} />
          {!disabled && selectedID === layer.id && (
            <div
              className="scene-resize-handle"
              onPointerDown={(event) => startDrag(event, layer, "resize")}
              onPointerMove={moveDrag}
              onPointerUp={() => { dragRef.current = null; }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function SceneLayerPanel({
  layers,
  selectedID,
  disabled,
  onSelect,
  onChange,
}: {
  layers: SceneImageLayer[];
  selectedID: string | null;
  disabled?: boolean;
  onSelect: (id: string | null) => void;
  onChange: (layers: SceneImageLayer[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  async function addImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("รองรับเฉพาะไฟล์รูปภาพ");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("รูปต้องมีขนาดไม่เกิน 5 MB");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const asset = await uploadSceneAsset(file);
      const id = `image-${Date.now().toString(36)}`;
      const layer: SceneImageLayer = {
        id, type: "image", name: file.name, src: asset.url,
        x: 70, y: 5, width: 25, height: 25, opacity: 1,
        zIndex: Math.max(0, ...layers.map((item) => item.zIndex)) + 1,
        visible: true,
      };
      onChange([...layers, layer]);
      onSelect(id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "อัปโหลด Asset ไม่สำเร็จ");
    } finally {
      setUploading(false);
    }
  }

  function update(id: string, patch: Partial<SceneImageLayer>) {
    onChange(layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer));
  }

  return (
    <div className="scene-layer-panel">
      <div className="scene-layer-toolbar">
        <div>
          <Layers3 size={16} />
          <strong>Scene Layers</strong>
          <span>{layers.length}</span>
        </div>
        <Button variant="secondary" size="sm" disabled={disabled || uploading} isLoading={uploading} onClick={() => fileInput.current?.click()}>
          <ImagePlus size={15} /> {uploading ? "กำลังอัปโหลด" : "เพิ่มรูป"}
        </Button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={addImage} />
      </div>
      {error && <p className="scene-layer-error">{error}</p>}
      {layers.length === 0 ? (
        <p className="scene-layer-empty">ยังไม่มี Graphic Layer · เพิ่ม Logo หรือ PNG เพื่อวางซ้อนบน Program Preview</p>
      ) : (
        <div className="scene-layer-list">
          {[...layers].sort((a, b) => b.zIndex - a.zIndex).map((layer) => (
            <button key={layer.id} className={selectedID === layer.id ? "selected" : ""} onClick={() => onSelect(layer.id)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={layer.src} alt="" />
              <span><strong>{layer.name}</strong><small>IMAGE · Z {layer.zIndex}</small></span>
              <i
                role="button"
                aria-label={layer.visible ? "ซ่อน Layer" : "แสดง Layer"}
                onClick={(event) => { event.stopPropagation(); update(layer.id, { visible: !layer.visible }); }}
              >{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</i>
              <i
                role="button"
                aria-label="ลบ Layer"
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(layers.filter((item) => item.id !== layer.id));
                  if (selectedID === layer.id) onSelect(null);
                }}
              ><Trash2 size={14} /></i>
            </button>
          ))}
        </div>
      )}
      {disabled && <p className="scene-layer-hint">หยุดถ่ายทอดสดก่อนแก้ Scene</p>}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
