export interface ModelGatewayDefinition {
  id: string;
  name: string;
  url: string;
  apiKeyEnv: string | null;
}

export type GatewayModelState = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface GatewayModel {
  id: string;
  name: string;
  description: string;
  kind: string;
  group: string | null;
  nativeModel: string;
  api?: "openai-compatible";
  state: GatewayModelState;
  contextSize: number | null;
  parallelSlots?: number;
  kvCache?: { k: string; v: string };
  runtime?: string;
  supportsVision: boolean;
  sizeBytes: number | null;
  workspacePath: string | null;
  ttlSeconds: number | null;
  chatParams?: Record<string, unknown>;
}

export interface ModelGatewaySnapshot {
  gateway: ModelGatewayDefinition;
  online: boolean;
  models: readonly GatewayModel[];
  error: string | null;
}
