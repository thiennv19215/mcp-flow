export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

export interface FlowProject {
  id: string;
  name: string;
  url: string;
  active?: boolean;
}

export type DownloadQuality = "original" | "upscaled";
export type MediaKind = "image" | "video";
export type NativeMedia = { id?: string; title: string; kind: MediaKind };

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  variants?: number;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}
