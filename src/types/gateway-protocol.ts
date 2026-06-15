// ============================================================
// gateway-protocol.ts — v3
// Shared type contract between matter-gateway and matter-cloud.
// Copy this file verbatim into both repos under src/types/.
// DO NOT import from this file with a relative path that
// crosses repo boundaries — copy it, don't symlink it.
// ============================================================

// ─── Shared records ─────────────────────────────────────────

export interface DeviceCacheRecord {
  nodeId: string;
  name: string;
  type: string;
  addedAt: string; // ISO timestamp
}

export interface GroupCacheRecord {
  groupId: number;
  name: string;
  members: string[]; // array of nodeId strings
}

// ─── All 24 command actions ──────────────────────────────────

export type CommandAction =
  // Device / system (13)
  | "on"
  | "off"
  | "toggle"
  | "level"
  | "level_move"
  | "level_stop"
  | "level_step"
  | "color_temperature"
  | "timed_on"
  | "commission"
  | "decommission"
  | "discover_capabilities"
  | "ble_status"
  // Groups (11)
  | "list_groups"
  | "create_group"
  | "delete_group"
  | "rename_group"
  | "add_group_member"
  | "remove_group_member"
  | "group_on"
  | "group_off"
  | "group_toggle"
  | "group_level"
  | "group_color_temperature"
  | "get_device_group_membership";

// ─── Timeout map (milliseconds) ─────────────────────────────
// commission: 60s — covers the slow BLE+Wi-Fi path
// delete_group, add_group_member, group_*: 15s — fan-out latency
// everything else: 10s

export const COMMAND_TIMEOUTS: Record<CommandAction, number> = {
  commission: 60_000,
  delete_group: 15_000,
  add_group_member: 15_000,
  group_on: 15_000,
  group_off: 15_000,
  group_toggle: 15_000,
  group_level: 15_000,
  group_color_temperature: 15_000,
  // 10s for everything else
  on: 10_000,
  off: 10_000,
  toggle: 10_000,
  level: 10_000,
  level_move: 10_000,
  level_stop: 10_000,
  level_step: 10_000,
  color_temperature: 10_000,
  timed_on: 10_000,
  decommission: 10_000,
  discover_capabilities: 10_000,
  ble_status: 10_000,
  list_groups: 10_000,
  create_group: 10_000,
  rename_group: 10_000,
  remove_group_member: 10_000,
  get_device_group_membership: 10_000,
};

// ─── Gateway → Cloud messages ────────────────────────────────

export interface AuthMsg {
  type: "auth";
  token: string;
}

export interface InitStateMsg {
  type: "init_state";
  devices: DeviceCacheRecord[];
  groups: GroupCacheRecord[];
}

export interface HeartbeatMsg {
  type: "heartbeat";
  timestamp: string; // ISO
}

export interface ResponseMsg {
  type: "response";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Event payloads ──────────────────────────────────────────

export interface StateChangeEvent {
  event: "state_change";
  nodeId: string;
  attribute: string;
  value: unknown;
}

export interface EnergySnapshotEvent {
  event: "energy_snapshot";
  nodeId: string;
  power: number;
  energy: number;
}

export interface DeviceConnectivityEvent {
  event: "device_online" | "device_offline";
  nodeId: string;
}

export type GatewayEvent =
  | StateChangeEvent
  | EnergySnapshotEvent
  | DeviceConnectivityEvent;

export interface EventMsg {
  type: "event";
  event: GatewayEvent["event"];
  [key: string]: unknown; // the rest of the event payload
}

export type GatewayToCloud =
  | AuthMsg
  | InitStateMsg
  | HeartbeatMsg
  | ResponseMsg
  | EventMsg;

// ─── Cloud → Gateway messages ────────────────────────────────

export interface PingMsg {
  type: "ping";
}

// ─── Command payload shapes ──────────────────────────────────

export interface CommissionPayload {
  pairingCode: string;
  name: string;
  type?: string;
  wifi?: {
    ssid: string;
    password: string; // NEVER log or persist this field
  };
}

export interface LevelPayload {
  level: number;
  transitionTime?: number;
}

export interface LevelMovePayload {
  direction: "up" | "down";
  rate?: number;
}

export interface LevelStepPayload {
  direction: "up" | "down";
  stepSize?: number;
  transitionTime?: number;
}

export interface ColorTemperaturePayload {
  mireds: number;
  transitionTime?: number;
}

export interface TimedOnPayload {
  onTime: number;
  offWaitTime?: number;
}

export interface CreateGroupPayload {
  groupId: number;
  name: string;
}

export interface DeleteGroupPayload {
  groupId: number;
}

export interface RenameGroupPayload {
  groupId: number;
  name: string;
}

export interface GroupMemberPayload {
  groupId: number;
  nodeId: string;
}

export interface GroupControlPayload {
  groupId: number;
}

export interface GroupLevelPayload {
  groupId: number;
  level: number;
  transitionTime?: number;
}

export interface GroupColorTemperaturePayload {
  groupId: number;
  mireds: number;
  transitionTime?: number;
}

// ─── CommandMsg — discriminated union on action ───────────────

export type CommandMsg =
  | { type: "command"; requestId: string; action: "on" | "off" | "toggle" | "decommission" | "discover_capabilities" | "level_stop" | "ble_status" | "list_groups"; nodeId?: string }
  | { type: "command"; requestId: string; action: "level"; nodeId: string; payload: LevelPayload }
  | { type: "command"; requestId: string; action: "level_move"; nodeId: string; payload: LevelMovePayload }
  | { type: "command"; requestId: string; action: "level_step"; nodeId: string; payload: LevelStepPayload }
  | { type: "command"; requestId: string; action: "color_temperature"; nodeId: string; payload: ColorTemperaturePayload }
  | { type: "command"; requestId: string; action: "timed_on"; nodeId: string; payload: TimedOnPayload }
  | { type: "command"; requestId: string; action: "commission"; payload: CommissionPayload }
  | { type: "command"; requestId: string; action: "create_group"; payload: CreateGroupPayload }
  | { type: "command"; requestId: string; action: "delete_group"; payload: DeleteGroupPayload }
  | { type: "command"; requestId: string; action: "rename_group"; payload: RenameGroupPayload }
  | { type: "command"; requestId: string; action: "add_group_member" | "remove_group_member"; payload: GroupMemberPayload }
  | { type: "command"; requestId: string; action: "group_on" | "group_off" | "group_toggle"; payload: GroupControlPayload }
  | { type: "command"; requestId: string; action: "group_level"; payload: GroupLevelPayload }
  | { type: "command"; requestId: string; action: "group_color_temperature"; payload: GroupColorTemperaturePayload }
  | { type: "command"; requestId: string; action: "get_device_group_membership"; nodeId: string };

export type CloudToGateway = PingMsg | CommandMsg;
