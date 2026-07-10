"use client";

import { useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Eye, EyeOff, FlipHorizontal2, FlipVertical2, GripVertical, ImagePlus, Layers3, Plus, RotateCcw, RotateCw, Trash2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadSceneAsset } from "@/lib/api";
import type { SceneImageLayer } from "@/lib/scene";

export type StudioSceneItem = {
  key: string;
  name: string;
};

export function SceneCollectionPanel({
  scenes,
  selectedKey,
  programKey,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
}: {
  scenes: StudioSceneItem[];
  selectedKey: string;
  programKey: string | null;
  onSelect: (key: string) => void;
  onAdd: () => void;
  onDuplicate: (key: string) => void;
  onDelete: (key: string) => void;
}) {
  return (
    <div className="scene-collection-panel">
      <div className="scene-layer-toolbar">
        <div><Layers3 size={16} /><strong>Scenes</strong><span>{scenes.length}</span></div>
        <Button variant="secondary" size="sm" onClick={onAdd}><Plus size={15} /> เพิ่ม Scene</Button>
      </div>
      <div className="scene-collection-list">
        {scenes.map((scene) => (
          <button
            key={scene.key}
            className={selectedKey === scene.key ? "selected" : ""}
            onClick={() => onSelect(scene.key)}
          >
            <span>
              <strong>{scene.name}</strong>
              <small>{programKey === scene.key ? "PROGRAM" : selectedKey === scene.key ? "PREVIEW" : "SCENE"}</small>
            </span>
            <i role="button" aria-label="ทำสำเนา Scene" onClick={(event) => { event.stopPropagation(); onDuplicate(scene.key); }}><Copy size={14} /></i>
            <i role="button" aria-label="ลบ Scene" onClick={(event) => { event.stopPropagation(); onDelete(scene.key); }}><Trash2 size={14} /></i>
          </button>
        ))}
      </div>
    </div>
  );
}

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
          title={disabled ? undefined : layer.name}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={layer.src}
            alt={layer.name}
            draggable={false}
            style={{ transform: layerTransform(layer) }}
          />
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
  cameraSources,
  cameraSourceIDs,
  selectedCameraID,
  selectedID,
  disabled,
  onCameraAdd,
  onCameraRemove,
  onCameraSelect,
  onSelect,
  onChange,
}: {
  layers: SceneImageLayer[];
  cameraSources: Array<{ id: string; name: string }>;
  cameraSourceIDs: string[];
  selectedCameraID?: string;
  selectedID: string | null;
  disabled?: boolean;
  onCameraAdd: (id: string) => void;
  onCameraRemove: (id: string) => void;
  onCameraSelect: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onChange: (layers: SceneImageLayer[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [draggingID, setDraggingID] = useState<string | null>(null);
  const [showCameraPicker, setShowCameraPicker] = useState(false);
  const addableCameras = cameraSources.filter((camera) => !cameraSourceIDs.includes(camera.id));

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
        visible: true, flipH: false, flipV: false, rotation: 0,
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

  function rotate(id: string, layer: SceneImageLayer, degrees: number) {
    update(id, { rotation: normalizeRotation((layer.rotation ?? 0) + degrees) });
  }

  function reorderLayers(targetID: string) {
    if (!draggingID || draggingID === targetID) return;
    const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex);
    const from = ordered.findIndex((layer) => layer.id === draggingID);
    const to = ordered.findIndex((layer) => layer.id === targetID);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    onChange(ordered.map((layer, index) => ({ ...layer, zIndex: ordered.length - index })));
  }

  function allowLayerDrop(event: DragEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  return (
    <div className="scene-layer-panel">
      <div className="scene-layer-toolbar">
        <div>
          <Layers3 size={16} />
          <strong>Sources</strong>
          <span>{layers.length + cameraSourceIDs.length}</span>
        </div>
        <div className="scene-source-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || addableCameras.length === 0}
            title={cameraSources.length === 0 ? "ยังไม่มีกล้องเชื่อมต่อใน Cameras" : addableCameras.length === 0 ? "เพิ่มกล้องที่เชื่อมต่อครบแล้ว" : "เพิ่มกล้องจาก Cameras"}
            onClick={() => setShowCameraPicker((current) => !current)}
          >
            <Video size={15} /> Add Camera
          </Button>
          <Button variant="secondary" size="sm" disabled={disabled || uploading} isLoading={uploading} onClick={() => fileInput.current?.click()}>
            <ImagePlus size={15} /> {uploading ? "กำลังอัปโหลด" : "เพิ่มรูป"}
          </Button>
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={addImage} />
      </div>
      {showCameraPicker && addableCameras.length > 0 && (
        <div className="scene-camera-picker">
          <small>CONNECTED CAMERAS</small>
          {addableCameras.map((camera) => (
            <button
              key={camera.id}
              onClick={() => {
                onCameraAdd(camera.id);
                onSelect(null);
                setShowCameraPicker(false);
              }}
            >
              <Video size={15} />
              <span><strong>{camera.name}</strong><small>{camera.id}</small></span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="scene-layer-error">{error}</p>}
      {cameraSourceIDs.length === 0 && layers.length === 0 ? (
        <p className="scene-layer-empty">ยังไม่มี Source · เชื่อมกล้องให้แสดงใน Cameras แล้วกด Add Camera หรือเพิ่ม Graphic</p>
      ) : (
        <div className="scene-layer-list">
          {cameraSourceIDs.map((cameraID) => {
            const camera = cameraSources.find((item) => item.id === cameraID);
            const isSelected = cameraID === selectedCameraID;
            return (
              <button key={cameraID} className={`scene-camera-source ${isSelected ? "selected" : ""}`} onClick={() => { onCameraSelect(cameraID); onSelect(null); }}>
                <span className="scene-layer-spacer" />
                <span className="scene-camera-source-icon"><Video size={19} /></span>
                <span>
                  <strong>{camera?.name ?? cameraID}</strong>
                  <small>CAMERA · {camera ? "CONNECTED" : "OFFLINE"}{isSelected ? " · PREVIEW" : ""}</small>
                </span>
                <i aria-label={isSelected ? "กล้องที่เลือก" : "เลือกกล้อง"}>{isSelected ? <Eye size={14} /> : <EyeOff size={14} />}</i>
                <i
                  role="button"
                  aria-label="นำกล้องออกจาก Scene"
                  onClick={(event) => { event.stopPropagation(); onCameraRemove(cameraID); }}
                ><Trash2 size={14} /></i>
              </button>
            );
          })}
          {[...layers].sort((a, b) => b.zIndex - a.zIndex).map((layer) => (
            <button
              key={layer.id}
              className={`${selectedID === layer.id ? "selected" : ""} ${draggingID === layer.id ? "dragging" : ""}`}
              draggable={!disabled}
              onDragStart={(event) => {
                setDraggingID(layer.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", layer.id);
              }}
              onDragOver={allowLayerDrop}
              onDrop={(event) => {
                event.preventDefault();
                reorderLayers(layer.id);
                setDraggingID(null);
              }}
              onDragEnd={() => setDraggingID(null)}
              onClick={() => onSelect(layer.id)}
            >
              <GripVertical className="scene-layer-drag-handle" size={15} aria-label="ลากเพื่อเปลี่ยนลำดับ" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={layer.src} alt="" style={{ transform: layerTransform(layer) }} />
              <span>
                <strong>{layer.name}</strong>
                <small>
                  IMAGE · Z {layer.zIndex}
                  {layer.flipH ? " · FLIP H" : ""}
                  {layer.flipV ? " · FLIP V" : ""}
                  {layer.rotation ? ` · ${normalizeRotation(layer.rotation)}°` : ""}
                </small>
              </span>
              <i
                role="button"
                aria-label={layer.visible ? "ซ่อน Layer" : "แสดง Layer"}
                onClick={(event) => { event.stopPropagation(); update(layer.id, { visible: !layer.visible }); }}
              >{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</i>
              <i
                className={layer.flipH ? "active" : ""}
                role="button"
                aria-label={layer.flipH ? "ยกเลิก Flip H" : "Flip H"}
                title="Flip H"
                onClick={(event) => { event.stopPropagation(); update(layer.id, { flipH: !layer.flipH }); }}
              ><FlipHorizontal2 size={14} /></i>
              <i
                className={layer.flipV ? "active" : ""}
                role="button"
                aria-label={layer.flipV ? "ยกเลิก Flip V" : "Flip V"}
                title="Flip V"
                onClick={(event) => { event.stopPropagation(); update(layer.id, { flipV: !layer.flipV }); }}
              ><FlipVertical2 size={14} /></i>
              <i
                role="button"
                aria-label="หมุนซ้าย 15 องศา"
                title="หมุนซ้าย 15°"
                onClick={(event) => { event.stopPropagation(); rotate(layer.id, layer, -15); }}
              ><RotateCcw size={14} /></i>
              <i
                role="button"
                aria-label="หมุนขวา 15 องศา"
                title="หมุนขวา 15°"
                onClick={(event) => { event.stopPropagation(); rotate(layer.id, layer, 15); }}
              ><RotateCw size={14} /></i>
              <i
                className={layer.rotation ? "active" : ""}
                role="button"
                aria-label="รีเซ็ตองศาการหมุน"
                title="รีเซ็ตหมุน 0°"
                onClick={(event) => { event.stopPropagation(); update(layer.id, { rotation: 0 }); }}
              >0°</i>
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

function normalizeRotation(value: number) {
  return ((Math.round(value) % 360) + 360) % 360;
}

function layerTransform(layer: SceneImageLayer) {
  const rotation = normalizeRotation(layer.rotation ?? 0);
  return `rotate(${rotation}deg) scale(${layer.flipH ? -1 : 1}, ${layer.flipV ? -1 : 1})`;
}
