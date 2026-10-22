export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  screen?: {
    state: "signed_out" | "project_error" | "agent_blocked" | "media_viewer" | "ready" | "unknown";
    reason?: string;
    projectId?: string | null;
    isProjectEditor?: boolean;
    composerVisible?: boolean;
    agentModeActive?: boolean;
    agentPanelOpen?: boolean;
    signInControlCount?: number;
    configuredSignedOutIndicatorCount?: number;
    configuredProjectErrorIndicatorCount?: number;
    projectHomeRecoveryLinkCount?: number;
    visibleAlertCount?: number;
    errorMessage?: string;
  };
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
  characterListDiagnostics?: CharacterListDiagnostics | null;
}

export interface CharacterListDiagnostics {
  result: "complete" | "confirmed_empty" | "incomplete" | "scanning";
  scanComplete?: boolean;
  nameCount?: number;
  stableUuidCount?: number;
  projectId?: string | null;
  checkedAt?: string;
  errorCode?: string;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

export interface FlowCharacter {
  name: string;
  /** Stable Flow character UUID when the library tile exposes one. */
  uuid?: string;
  use_as?: string;
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
