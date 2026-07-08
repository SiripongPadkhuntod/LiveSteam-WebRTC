export type SceneImageLayer = {
  id: string;
  type: "image";
  name: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  zIndex: number;
  visible: boolean;
};

export type ProgramScene = {
  id: string;
  name: string;
  revision: number;
  sourceId?: string;
  output: { width: 1920; height: 1080; fps: 60 };
  layers: SceneImageLayer[];
};

export function emptyProgramScene(roomName: string): ProgramScene {
  return {
    id: `${roomName}-main`,
    name: "Main Scene",
    revision: 1,
    output: { width: 1920, height: 1080, fps: 60 },
    layers: [],
  };
}
