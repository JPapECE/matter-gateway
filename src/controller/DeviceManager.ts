/**
 * DeviceManager.ts — matter.js 0.16.x
 *
 * ─── Matter Spec Coverage ────────────────────────────────────────────────────
 * Implements the full cluster set for Matter smart plug device types:
 * 0x010A  On/Off Plug-in Unit    — Identify, Groups, Scenes, On/Off, [Level]
 * 0x010B  Dimmable Plug-In Unit  — Identify, Groups, Scenes, On/Off, Level
 * 0x0303  Pump                   — On/Off, PumpConfigControl, Identify, [Level]
 *
 * Optional energy clusters (device-dependent, discovered at runtime):
 * 0x0090  ElectricalPowerMeasurement   — activePower, voltage, activeCurrent
 * 0x0091  ElectricalEnergyMeasurement  — cumulativeEnergyImported
 *
 * ─── On/Off Cluster Feature Flags (spec §1.5.4) ──────────────────────────────
 * The On/Off cluster exposes a FeatureMap attribute (mandatory on all clusters
 * per Matter Core §7.13) with the following bits:
 *
 * Bit 0  LT  Lighting          — enables OnWithTimedOff, OffWithEffect,
 * OnWithRecallGlobalScene, GlobalSceneControl,
 * OnTime, OffWaitTime, StartUpOnOff.
 * Bit 1  DF  DeadFrontBehaviour — other clusters report INVALID_IN_STATE when off.
 *
 * Per Matter Device Library spec §5.1.5, OnOffPlugInUnit SHALL implement LT
 * (conformance = M). However, the Shelly Plug S firmware (as of early 2024)
 * returns UNSUPPORTED_COMMAND (0x81) for OnWithTimedOff. This is a real-world
 * spec-compliance gap documented in this thesis.
 *
 * Our approach:
 * 1. Probe FeatureMap before calling OnWithTimedOff.
 * 2. If LT absent OR command is rejected at runtime, fall back to a
 * software timer: on() + setTimeout → off().
 *
 * ─── discoverCapabilities() — safe, no side effects ─────────────────────────
 * Reads only subscription-cache state. Does NOT send any commands to the device.
 * This prevents the previous bug where discovery accidentally sent an on() command.
 *
 * ─── Multi-endpoint support ──────────────────────────────────────────────────
 * getAllEndpoints() returns ALL non-root endpoints as a Map<id, endpoint>.
 * discoverCapabilities() merges cluster lists across ALL endpoints so that
 * devices with a separate electrical sensor endpoint (ep2) are correctly
 * detected. getPrimaryEndpoint() returns ep1 (or the first endpoint) for
 * commands — On/Off, Level Control always live on the primary endpoint.
 *
 * This handles:
 * - Simple plugs:        ep1 only  (On/Off, optional Level)
 * - Energy-aware plugs:  ep1 + ep2 (On/Off on ep1, power/energy on ep2)
 * - Bridges / strips:    ep1..epN  (each socket as a separate endpoint)
 */

import { OnOffClient }        from "@matter/main/behaviors/on-off";
import { LevelControlClient } from "@matter/main/behaviors/level-control";
import { DescriptorClient }   from "@matter/main/behaviors/descriptor";
import { ColorControlClient } from "@matter/main/behaviors/color-control";
import { matterController }   from "./MatterController.js";
import { eventForwarder }     from "../bridge/EventForwarder.js";

// ── Cluster IDs (Matter Application Cluster Spec R1.2 §1.1.2) ───────────────
export const CLUSTER_IDS = {
  IDENTIFY:                        0x0003,
  GROUPS:                          0x0004,
  SCENES:                          0x0005,
  ON_OFF:                          0x0006,
  LEVEL_CONTROL:                   0x0008,
  DESCRIPTOR:                      0x001D,
  ELECTRICAL_POWER_MEASUREMENT:    0x0090,
  ELECTRICAL_ENERGY_MEASUREMENT:   0x0091,
  PUMP_CONFIGURATION_AND_CONTROL:  0x0200,
  COLOR_CONTROL:                   0x0300,
} as const;

// ── On/Off FeatureMap bit positions (spec §1.5.4) ────────────────────────────
const ON_OFF_FEATURE_LT = 1 << 0;   // bit 0: Lighting feature

// ── Device Type IDs (Matter Device Library Spec R1.2 §5) ────────────────────
export const DEVICE_TYPE_IDS = {
  ON_OFF_PLUG_IN_UNIT:     0x010A,
  DIMMABLE_PLUG_IN_UNIT:   0x010B,
  PUMP:                    0x0303,
  COLOR_TEMPERATURE_LIGHT: 0x010C,
} as const;

export type PlugDeviceType =
  | "OnOffPlugInUnit"
  | "DimmablePlugInUnit"
  | "ColorTemperatureLight"
  | "Pump"
  | "Unknown";

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * DeviceCapabilities — built from Descriptor cluster (serverList + clientList)
 * across ALL endpoints, and the On/Off cluster FeatureMap from the primary
 * endpoint. Stored in SQLite.
 *
 * ─── serverList vs clientList (Matter Core Spec §9.5) ────────────────────────
 * The Descriptor cluster on every endpoint exposes two lists:
 *
 *   serverList — clusters the endpoint SERVES: it holds attributes and accepts
 *     incoming commands. All application clusters on a plug (On/Off, Level
 *     Control, energy clusters) live here. Our controller acts as the CLIENT
 *     sending commands to these server clusters.
 *
 *   clientList — clusters the endpoint acts as a CLIENT for: it can SEND
 *     commands to server clusters on OTHER endpoints. This is used in direct
 *     binding scenarios where devices talk to each other without a hub.
 *     Example from Matter Device Library R1.2 §5.3 (Pump device type):
 *       Temperature Measurement (Client) — pump can query a temperature sensor
 *       Pressure Measurement (Client)    — pump can query a pressure sensor
 *       Flow Measurement (Client)        — pump can query a flow sensor
 *       Occupancy Sensing (Client)       — pump can react to occupancy sensor
 *     For OnOffPlugInUnit and DimmablePlugInUnit, clientList is typically
 *     empty — they are pure actuators with no built-in controller logic.
 *
 * Our capability flags (hasOnOff, hasLevelControl, etc.) are derived from
 * serverList only — we don't send commands to the plug's client clusters
 * (those are for device-to-device bindings). clientList is stored and exposed
 * in the API for completeness.
 */
export interface DeviceCapabilities {
  nodeId:                  string;
  deviceType:              PlugDeviceType;
  deviceTypeId:            number;
  serverClusters:          number[];
  clientClusters:          number[];
  clusters:                number[];
  hasOnOff:                boolean;
  hasLevelControl:         boolean;
  hasElectricalPower:      boolean;
  hasElectricalEnergy:     boolean;
  hasPumpControl:          boolean;
  hasOnOffLightingFeature: boolean | null;
  hasColorTemperature:     boolean;
  colorTempMinKelvin:      number | null;
  colorTempMaxKelvin:      number | null;
}

/** On/Off + Level state from subscription cache (no network call). */
export interface DeviceStatus {
  nodeId:  string;
  online:  boolean;
  on:      boolean | null;
  level:   number | null;
}

export interface TimedOnResult {
  onTimeSecs:      number;
  offWaitTimeSecs: number;
}

/**
 * PowerReading — from ElectricalPowerMeasurement cluster (0x0090).
 * Spec stores int64 milli-units; we return SI units.
 */
export interface PowerReading {
  nodeId:      string;
  activePower: number | null;
  voltage:     number | null;
  current:     number | null;
  timestamp:   string;
}

/**
 * EnergyReading — from ElectricalEnergyMeasurement cluster (0x0091).
 * "Imported" = consumed from the grid (normal plug use case).
 */
export interface EnergyReading {
  nodeId:                   string;
  cumulativeEnergy:         number | null;
  periodicEnergy:           number | null;
  cumulativeEnergyExported: number | null;
  periodicEnergyExported:   number | null;
  timestamp:                string;
}

let ElectricalPowerMeasurementClient:  any = null;
let ElectricalEnergyMeasurementClient: any = null;

async function loadOptionalClients(): Promise<void> {
  try {
    const m = await import("@matter/main/behaviors/electrical-power-measurement" as string);
    ElectricalPowerMeasurementClient = m.ElectricalPowerMeasurementClient;
    console.log("[DeviceManager] ElectricalPowerMeasurementClient loaded.");
  } catch {
    console.info("[DeviceManager] ElectricalPowerMeasurementClient unavailable — power readings disabled.");
  }

  try {
    const m = await import("@matter/main/behaviors/electrical-energy-measurement" as string);
    ElectricalEnergyMeasurementClient = m.ElectricalEnergyMeasurementClient;
    console.log("[DeviceManager] ElectricalEnergyMeasurementClient loaded.");
  } catch {
    console.info("[DeviceManager] ElectricalEnergyMeasurementClient unavailable — energy readings disabled.");
  }
}

// ── DeviceManager ─────────────────────────────────────────────────────────────

class DeviceManager {
  private registeredPeers = new Set<string>();
  private boundSubscriptions = new Set<string>();

  constructor() {
    loadOptionalClients();
  }

  /** Broadcasts a structured event payload out to all active WebSockets */
  public broadcast(payload: any): void {
    eventForwarder.forward(payload);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private getPeer(nodeId: string): any | null {
    return matterController.node.peers.get(nodeId) ?? null;
  }

  /**
   * getAllEndpoints() — returns ALL non-root endpoints as a Map<id, endpoint>.
   *
   * matter.js 0.16.x stores endpoints in a Parts container that:
   *   - Is iterable via forEach (Symbol.iterator)
   *   - Is NOT a Map (no entries(), no keys() that work reliably)
   *   - Is populated asynchronously after the subscription completes
   *
   * Skips: "root", "ep0", "0" — these are the root node endpoint which only
   * carries fabric management clusters, not application clusters.
   *
   * Returns an empty Map if Parts is not yet populated (caller should retry).
   */
  private getAllEndpoints(nodeId: string): Map<string, any> {
    const result = new Map<string, any>();
    const peer   = this.getPeer(nodeId);
    if (!peer) return result;

    const parts = (peer as any).parts;
    if (!parts) return result;

    try {
      parts.forEach((part: any) => {
        const id = String(part?.id ?? part?.number ?? "");
        if (id === "root" || id === "ep0" || id === "0" || id === "") return;
        result.set(id, part);
      });
    } catch {
      // Parts not iterable yet
    }

    if (result.size === 0) {
      for (const key of ["ep1", "ep2", "ep3", "1", "2", "3", "plug", "sensor"]) {
        const part = parts.get?.(key);
        if (part !== undefined) result.set(key, part);
      }
    }

    return result;
  }

  /**
   * getPrimaryEndpoint() — returns ep1 (or the first non-root endpoint).
   *
   * All On/Off, Level Control, and Identify commands target the primary endpoint.
   * For energy readings we use the endpoint that actually carries the cluster
   * (found via discoverCapabilities or searched across all endpoints in getPower/getEnergy).
   */
  private getPrimaryEndpoint(nodeId: string): any | null {
    const map = this.getAllEndpoints(nodeId);
    if (map.size === 0) return null;
    return map.get("ep1") ?? map.get("1") ?? [...map.values()][0];
  }

  /**
   * getEndpointWithCluster() — finds the first endpoint that serves a given cluster.
   *
   * Used by getPower() and getEnergy() to locate the electrical sensor endpoint
   * (which may be ep2 rather than ep1 on virtual and multi-endpoint devices).
   */
  private getEndpointWithCluster(nodeId: string, clusterId: number): any | null {
    const peer = this.getPeer(nodeId);
    if (!peer || !peer.lifecycle.isOnline) return null;

    for (const [, ep] of this.getAllEndpoints(nodeId)) {
      try {
        const state = ep.stateOf(DescriptorClient);
        if ((state.serverList as number[]).map(Number).includes(clusterId)) {
          return ep;
        }
      } catch {
        // Descriptor not cached yet
      }
    }
    return null;
  }

  /**
   * hasCluster() — checks the Descriptor serverList from the subscription cache.
   * No network call. Returns false if the cache is not yet populated.
   */
  private hasCluster(ep: any, clusterId: number): boolean {
    try {
      const state = ep.stateOf(DescriptorClient);
      return (state.serverList as number[]).map(Number).includes(clusterId);
    } catch {
      return false;
    }
  }

  /**
   * readOnOffFeatureMap() — reads FeatureMap from On/Off cluster subscription cache.
   *
   * FeatureMap is mandatory on every Matter cluster (Core spec §7.13).
   * matter.js may expose it as a raw number or as a named-bit object depending
   * on version. We handle both representations.
   *
   * Returns null if the cache is not yet populated (device hasn't connected yet).
   */
  private readOnOffFeatureMap(ep: any): number | null {
    try {
      const state = ep.stateOf(OnOffClient);
      const raw   = (state as any).featureMap;
      if (raw == null) return null;
      if (typeof raw === "number") return raw;
      if (typeof raw === "object") {
        let bitmap = 0;
        if (raw.lighting) bitmap |= ON_OFF_FEATURE_LT;
        return bitmap;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * hasLightingFeature() — true if On/Off FeatureMap bit 0 (LT) is set.
   *
   * Controls availability of: OnWithTimedOff, OffWithEffect,
   * OnWithRecallGlobalScene, GlobalSceneControl, OnTime, OffWaitTime,
   * StartUpOnOff attributes.
   */
  private hasLightingFeature(ep: any): boolean {
    const fm = this.readOnOffFeatureMap(ep);
    if (fm === null) return false;
    return (fm & ON_OFF_FEATURE_LT) !== 0;
  }

  /**
   * readColorTempRange() — reads physical CT limits from subscription cache.
   * Returns min/max in Kelvin (converted from mireds).
   * colorTempPhysicalMinMireds = coolest (highest K) → maxKelvin
   * colorTempPhysicalMaxMireds = warmest (lowest K) → minKelvin
   */
  private readColorTempRange(ep: any): { minKelvin: number | null; maxKelvin: number | null } {
    try {
      const state   = ep.stateOf(ColorControlClient) as any;
      const minM    = state.colorTempPhysicalMinMireds;
      const maxM    = state.colorTempPhysicalMaxMireds;
      return {
        minKelvin: maxM ? Math.round(1_000_000 / maxM) : null,
        maxKelvin: minM ? Math.round(1_000_000 / minM) : null,
      };
    } catch {
      return { minKelvin: null, maxKelvin: null };
    }
  }

  private resolveDeviceType(id: number): PlugDeviceType {
    switch (id) {
      case DEVICE_TYPE_IDS.ON_OFF_PLUG_IN_UNIT:     return "OnOffPlugInUnit";
      case DEVICE_TYPE_IDS.DIMMABLE_PLUG_IN_UNIT:   return "DimmablePlugInUnit";
      case DEVICE_TYPE_IDS.COLOR_TEMPERATURE_LIGHT: return "ColorTemperatureLight";
      case DEVICE_TYPE_IDS.PUMP:                    return "Pump";
      default:                                      return "Unknown";
    }
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  /** Helper method to cleanly bind all live Matter fabric cluster subscriptions */
  private bindPhysicalStateSubscription(nodeId: string): void {
    if (this.boundSubscriptions.has(nodeId)) return;
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) return;
    this.boundSubscriptions.add(nodeId);

    // 1. Monitor Physical On/Off Changes
    if (this.hasCluster(ep, CLUSTER_IDS.ON_OFF)) {
      try {
        console.log(`[DeviceManager] Establishing On/Off WS subscription for ${nodeId}`);
        ep.events.onOff.onOff$Changed.on((value: boolean) => {
            console.log(`[Fabric Event] Physical On/Off change: ${value}`);
            this.broadcast({ event: "state_change", nodeId, attribute: "onOff", value });
        });
      } catch (err) {
        console.warn(`[DeviceManager] Failed binding On/Off event for ${nodeId}:`, err);
      }
    }

    // 2. Monitor Physical Level/Dimming Changes (e.g., Smart Bulbs / Dimmers)
    if (this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      try {
        console.log(`[DeviceManager] Establishing Level Control WS subscription for ${nodeId}`);
        ep.events.levelControl.currentLevel$Changed.on((value: number) => {
            console.log(`[Fabric Event] Physical Level change: ${value}`);
            this.broadcast({ event: "state_change", nodeId, attribute: "currentLevel", value });
        });
      } catch (err) {
        console.warn(`[DeviceManager] Failed binding Level Control event for ${nodeId}:`, err);
      }
    }

    // 3. Monitor Physical Color Temperature Changes (e.g., Warm/Cool Bulbs)
    if (this.hasCluster(ep, CLUSTER_IDS.COLOR_CONTROL)) {
      try {
        console.log(`[DeviceManager] Establishing Color Control WS subscription for ${nodeId}`);
        ep.events.colorControl.colorTemperatureMireds$Changed.on((value: number) => {
            const kelvin = Math.round(1_000_000 / value);
            console.log(`[Fabric Event] Physical Color change: ${value} mireds (${kelvin}K)`);
            this.broadcast({ 
                event: "state_change", 
                nodeId, 
                attribute: "colorTemperature", 
                value: { mireds: value, kelvin: kelvin } 
            });
        });
      } catch (err) {
        console.warn(`[DeviceManager] Failed binding Color Control event for ${nodeId}:`, err);
      }
    }
  }
  
  private setupPeerLifecycle(nodeId: string): void {
    if (this.registeredPeers.has(nodeId)) return;
    const peer = this.getPeer(nodeId);
    if (!peer) return;

    this.registeredPeers.add(nodeId);

    peer.lifecycle.online.on(() => {
      console.log(`[Lifecycle Event] Peer ${nodeId} is ONLINE`);
      this.bindPhysicalStateSubscription(nodeId);
      this.broadcast({ event: "state_change", nodeId, attribute: "online", value: true });
    });

    peer.lifecycle.offline.on(() => {
      console.log(`[Lifecycle Event] Peer ${nodeId} is OFFLINE`);
      this.broadcast({ event: "state_change", nodeId, attribute: "online", value: false });
    });
  }

  async logKnownPeers(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    for (const id of nodeIds) {
      const peer = this.getPeer(id);
      if (peer) {
        console.log(`[DeviceManager] Peer ${id} in fabric — starting connection and lifecycle setup...`);
        this.setupPeerLifecycle(id);
        
        // Start the peer in a non-blocking way to trigger discovery and CASE establishment
        peer.start().catch((err: any) => {
          console.error(`[DeviceManager] Failed to start peer ${id}:`, err.message);
        });

        // If it's already running or initialized, bind immediately
        if (peer.lifecycle.isOnline) {
          this.bindPhysicalStateSubscription(id);
        }
      } else {
        console.warn(`[DeviceManager] Peer ${id} NOT in fabric — needs recommissioning.`);
      }
    }
  }

  async connect(nodeId: string): Promise<void> {
    const peer = this.getPeer(nodeId);
    if (!peer) { console.warn(`[DeviceManager] Peer ${nodeId} not in fabric.`); return; }
    console.log(`[DeviceManager] Peer ${nodeId} ready (CASE on demand).`);
    
    this.setupPeerLifecycle(nodeId);

    // Bind subscription immediately to newly commissioned hardware
    this.bindPhysicalStateSubscription(nodeId);
  }

  // ── Capability Discovery ───────────────────────────────────────────────────

  /**
   * discoverCapabilities()
   *
   * Reads the Descriptor cluster (serverList + clientList) from ALL endpoints
   * and the On/Off FeatureMap from the primary endpoint.
   * Does NOT send any commands.
   *
   * ─── Multi-endpoint merge strategy ───────────────────────────────────────
   * Matter devices can split clusters across endpoints:
   *   ep1 → On/Off plug          (clusters: 0x0003, 0x0004, 0x0005, 0x0006, 0x001D)
   *   ep2 → Electrical sensor    (clusters: 0x0090, 0x0091, 0x001D)
   *
   * We merge serverList and clientList across all endpoints so that
   * hasElectricalPower / hasElectricalEnergy are correctly set even when
   * the energy clusters live on a different endpoint than On/Off.
   *
   * deviceType is taken from the primary endpoint's deviceTypeList[0].
   * The primary endpoint is ep1 (or the first non-root endpoint found).
   */
  async discoverCapabilities(nodeId: string): Promise<DeviceCapabilities> {
    const unknown: DeviceCapabilities = {
      nodeId, deviceType: "Unknown", deviceTypeId: 0,
      serverClusters: [], clientClusters: [], clusters: [],
      hasOnOff: false, hasLevelControl: false,
      hasElectricalPower: false, hasElectricalEnergy: false, hasPumpControl: false,
      hasOnOffLightingFeature: null,
      hasColorTemperature: false, colorTempMinKelvin:  null, colorTempMaxKelvin:  null,
    };

    let endpointMap = new Map<string, any>();

    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, 1000));

      const peer = this.getPeer(nodeId);
      if (!peer) {
        console.warn(`[DeviceManager] Peer ${nodeId} disappeared during discovery.`);
        return unknown;
      }

      endpointMap = this.getAllEndpoints(nodeId);
      if (endpointMap.size > 0) {
        console.log(
          `[DeviceManager] Endpoints ready for ${nodeId} (attempt ${attempt}/15): ` +
          `[${[...endpointMap.keys()].join(", ")}]`
        );
        break;
      }
    }

    if (endpointMap.size === 0) {
      console.warn(`[DeviceManager] No application endpoints found for ${nodeId} after 15s.`);
      return unknown;
    }

    const primaryEp = endpointMap.get("ep1") ?? endpointMap.get("1") ?? [...endpointMap.values()][0];

    // ── Merge Descriptor clusters across ALL endpoints ─────────────────────
    let serverClusters: number[] = [];
    let clientClusters: number[] = [];
    let deviceTypeId:   number   = 0;

    for (const [epId, ep] of endpointMap) {
      try {
        const desc   = ep.stateOf(DescriptorClient);
        const server = (desc.serverList as number[]).map(Number);
        const client = ((desc as any).clientList as number[] ?? []).map(Number);

        serverClusters = [...new Set([...serverClusters, ...server])];
        clientClusters = [...new Set([...clientClusters, ...client])];

        if (ep === primaryEp && desc.deviceTypeList?.length > 0) {
          deviceTypeId = Number(desc.deviceTypeList[0].deviceType);
        }

        console.log(
          `[DeviceManager] ${nodeId}/${epId} ` +
          `server=[${server.map(c => "0x" + c.toString(16)).join(", ")}]` +
          (client.length ? ` client=[${client.map(c => "0x" + c.toString(16)).join(", ")}]` : "")
        );
      } catch (err) {
        console.warn(`[DeviceManager] Descriptor read failed for ${nodeId}/${epId}:`, err);
      }
    }

    const featureMap              = this.readOnOffFeatureMap(primaryEp);
    const hasOnOffLightingFeature = featureMap !== null ? (featureMap & ON_OFF_FEATURE_LT) !== 0 : null;
    const deviceType = this.resolveDeviceType(deviceTypeId);
    const clusters   = [...new Set([...serverClusters, ...clientClusters])];

    const caps: DeviceCapabilities = {
      nodeId, deviceType, deviceTypeId, serverClusters, clientClusters, clusters,
      hasOnOff:            serverClusters.includes(CLUSTER_IDS.ON_OFF),
      hasLevelControl:     serverClusters.includes(CLUSTER_IDS.LEVEL_CONTROL),
      hasElectricalPower:  serverClusters.includes(CLUSTER_IDS.ELECTRICAL_POWER_MEASUREMENT),
      hasElectricalEnergy: serverClusters.includes(CLUSTER_IDS.ELECTRICAL_ENERGY_MEASUREMENT),
      hasPumpControl:      serverClusters.includes(CLUSTER_IDS.PUMP_CONFIGURATION_AND_CONTROL),
      hasOnOffLightingFeature,
      hasColorTemperature: serverClusters.includes(CLUSTER_IDS.COLOR_CONTROL),
      colorTempMinKelvin:  null,
      colorTempMaxKelvin:  null,
    };

    if (caps.hasColorTemperature) {
      const range = this.readColorTempRange(primaryEp);
      caps.colorTempMinKelvin = range.minKelvin;
      caps.colorTempMaxKelvin = range.maxKelvin;
    }

    console.log(
      `[DeviceManager] ${nodeId} — type=${deviceType}` +
      ` server=[${serverClusters.map(c => "0x" + c.toString(16)).join(", ")}]` +
      ` client=[${clientClusters.map(c => "0x" + c.toString(16)).join(", ")}]` +
      ` LT=${hasOnOffLightingFeature} level=${caps.hasLevelControl}` +
      ` power=${caps.hasElectricalPower} energy=${caps.hasElectricalEnergy}`
    );

    return caps;
  }

  // ── On/Off commands ────────────────────────────────────────────────────────

  // ── On/Off commands inside DeviceManager.ts ─────────────────────────

  async turnOn(nodeId: string): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    await ep.commandsOf(OnOffClient).on();
    
    // Explicitly push the state mutation down the WebSocket channel immediately
    this.broadcast({ event: "state_change", nodeId, attribute: "onOff", value: true });
    console.log(`[DeviceManager] ON → ${nodeId}`);
  }

  async turnOff(nodeId: string): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    await ep.commandsOf(OnOffClient).off();
    
    // Explicitly push the state mutation down the WebSocket channel immediately
    this.broadcast({ event: "state_change", nodeId, attribute: "onOff", value: false });
    console.log(`[DeviceManager] OFF → ${nodeId}`);
  }

  async toggle(nodeId: string): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);

    await ep.commandsOf(OnOffClient).toggle();

    // Do NOT broadcast the new state here — the subscription event (onOff$Changed)
    // carries the authoritative value reported by the device and will arrive shortly.
    // Pre-reading the cache before the command returns can send a stale/wrong value
    // if the device was physically toggled since the last subscription report.
    console.log(`[DeviceManager] TOGGLE → ${nodeId}`);
  }

  async timedOn(nodeId: string, onTimeSecs: number, offWaitTimeSecs: number = 0): Promise<TimedOnResult> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);

    if (!this.hasLightingFeature(ep)) {
      throw new Error(`Device ${nodeId} does not support the On/Off Lighting feature (LT).`);
    }

    const onTime      = Math.min(Math.round(onTimeSecs * 10),      0xFFFE);
    const offWaitTime = Math.min(Math.round(offWaitTimeSecs * 10), 0xFFFE);

    await ep.commandsOf(OnOffClient).onWithTimedOff({
      onOffControl: { acceptOnlyWhenOn: false },
      onTime,
      offWaitTime,
    });

    this.broadcast({ event: "state_change", nodeId, attribute: "timedOnActive", value: { onTimeSecs, offWaitTimeSecs } });
    console.log(`[DeviceManager] TIMED-ON → ${nodeId} on=${onTimeSecs}s`);
    return { onTimeSecs, offWaitTimeSecs };
  }

  // ── Level Control commands ─────────────────────────────────────────────────

  async setLevel(nodeId: string, level: number, transitionTime: number = 0): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    if (!this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      throw new Error(`Device ${nodeId} does not support Level Control.`);
    }
    const clampedLevel = Math.max(1, Math.min(254, Math.round(level)));
    await ep.commandsOf(LevelControlClient).moveToLevelWithOnOff({
      level: clampedLevel, transitionTime,
      optionsMask:     { executeIfOff: false, coupleColorTempToLevel: false },
      optionsOverride: { executeIfOff: false, coupleColorTempToLevel: false },
    });
    this.broadcast({ event: "state_change", nodeId, attribute: "currentLevel", value: clampedLevel });
    console.log(`[DeviceManager] LEVEL → ${nodeId} level=${clampedLevel}`);
  }

  async moveLevel(nodeId: string, direction: "up" | "down", rate: number | null = null): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    if (!this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      throw new Error(`Device ${nodeId} does not support Level Control.`);
    }
    await ep.commandsOf(LevelControlClient).moveWithOnOff({
      moveMode: direction === "up" ? 0 : 1,
      rate:     rate ?? null,
      optionsMask:     { executeIfOff: false, coupleColorTempToLevel: false },
      optionsOverride: { executeIfOff: false, coupleColorTempToLevel: false },
    });
    console.log(`[DeviceManager] MOVE-${direction.toUpperCase()} → ${nodeId}`);
  }

  async stopLevel(nodeId: string): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    if (!this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      throw new Error(`Device ${nodeId} does not support Level Control.`);
    }
    await ep.commandsOf(LevelControlClient).stopWithOnOff({
      optionsMask:     { executeIfOff: false, coupleColorTempToLevel: false },
      optionsOverride: { executeIfOff: false, coupleColorTempToLevel: false },
    });
    console.log(`[DeviceManager] STOP-LEVEL → ${nodeId}`);
  }

  /**
   * stepLevel() — moves level by a fixed step amount in one command.
   *
   * Uses StepWithOnOff (Level Control cluster §3.10.7.5).
   * The device executes the step internally — no stop command needed.
   * This is the correct UX primitive for a mobile +/- button.
   *
   * @param direction    "up" or "down"
   * @param stepSize     How much to move (1–254). Default 25 (~10% of range).
   * @param transitionTime  Tenths of a second for the transition. Default 5 (0.5s).
   */
  async stepLevel(
    nodeId:         string,
    direction:      "up" | "down",
    stepSize:       number = 25,
    transitionTime: number = 5,
  ): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    if (!this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      throw new Error(`Device ${nodeId} does not support Level Control.`);
    }
    const clampedStep = Math.max(1, Math.min(254, Math.round(stepSize)));
    await ep.commandsOf(LevelControlClient).stepWithOnOff({
      stepMode:       direction === "up" ? 0 : 1,
      stepSize:       clampedStep,
      transitionTime,
      optionsMask:     { executeIfOff: false, coupleColorTempToLevel: false },
      optionsOverride: { executeIfOff: false, coupleColorTempToLevel: false },
    });
    console.log(`[DeviceManager] STEP-${direction.toUpperCase()} → ${nodeId}`);
  }

  // ── Status reads ───────────────────────────────────────────────────────────

  async getStatus(nodeId: string): Promise<DeviceStatus> {
    const peer = this.getPeer(nodeId);
    if (!peer || !peer.lifecycle.isOnline) return { nodeId, online: false, on: null, level: null };

    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) return { nodeId, online: true, on: null, level: null };

    let on:    boolean | null = null;
    let level: number  | null = null;

    try { on = ep.stateOf(OnOffClient).onOff as boolean; }
    catch (err) { console.error(`[DeviceManager] getStatus on/off failed for ${nodeId}:`, err); }

    if (this.hasCluster(ep, CLUSTER_IDS.LEVEL_CONTROL)) {
      try { level = ep.stateOf(LevelControlClient).currentLevel ?? null; }
      catch { /* fallback */ }
    }

    return { nodeId, online: true, on, level };
  }

  async getStatuses(nodeIds: string[]): Promise<Map<string, DeviceStatus>> {
    const result = new Map<string, DeviceStatus>();
    await Promise.all(nodeIds.map(async (id) => result.set(id, await this.getStatus(id))));
    return result;
  }

  // ── Energy monitoring ──────────────────────────────────────────────────────

  /**
   * getPower() — reads activePower, voltage, activeCurrent from
   * ElectricalPowerMeasurement cluster (0x0090).
   *
   * Searches ALL endpoints for the cluster — on virtual devices and some
   * real devices the energy cluster lives on ep2, not ep1.
   * Converts milli-units (spec) to SI units (API response).
   */
  async getPower(nodeId: string): Promise<PowerReading> {
    const ts  = new Date().toISOString();
    const nil: PowerReading = { nodeId, activePower: null, voltage: null, current: null, timestamp: ts };

    if (!ElectricalPowerMeasurementClient) return nil;
    const peer = this.getPeer(nodeId);
    if (!peer || !peer.lifecycle.isOnline) return nil;

    const ep = this.getEndpointWithCluster(nodeId, CLUSTER_IDS.ELECTRICAL_POWER_MEASUREMENT);
    if (!ep) return nil;

    try {
      const state = ep.stateOf(ElectricalPowerMeasurementClient);
      const n     = (v: any): number | null => v == null ? null : Number(v);
      return {
        nodeId,
        activePower: n(state.activePower)  !== null ? n(state.activePower)!  / 1000 : null,
        voltage:     n(state.voltage)      !== null ? n(state.voltage)!       / 1000 : null,
        current:     n(state.activeCurrent) !== null ? n(state.activeCurrent)! / 1000 : null,
        timestamp:   ts,
      };
    } catch (err) {
      console.error(`[DeviceManager] getPower failed for ${nodeId}:`, err);
      return nil;
    }
  }

  /**
   * getEnergy() — reads cumulativeEnergyImported and periodicEnergyImported
   * from ElectricalEnergyMeasurement cluster (0x0091).
   *
   * Searches ALL endpoints for the cluster.
   * Converts mWh (spec) to Wh (API response).
   */
  async getEnergy(nodeId: string): Promise<EnergyReading> {
    const ts  = new Date().toISOString();
    const nil: EnergyReading = { nodeId, cumulativeEnergy: null, periodicEnergy: null, cumulativeEnergyExported: null, periodicEnergyExported: null, timestamp: ts };

    if (!ElectricalEnergyMeasurementClient) return nil;
    const peer = this.getPeer(nodeId);
    if (!peer || !peer.lifecycle.isOnline) return nil;

    const ep = this.getEndpointWithCluster(nodeId, CLUSTER_IDS.ELECTRICAL_ENERGY_MEASUREMENT);
    if (!ep) return nil;

    try {
      const state   = ep.stateOf(ElectricalEnergyMeasurementClient);
      const mwhToWh = (s: any): number | null => s?.energy == null ? null : Number(s.energy) / 1000;

      return {
        nodeId,
        cumulativeEnergy:         mwhToWh(state.cumulativeEnergyImported),
        periodicEnergy:           mwhToWh(state.periodicEnergyImported),
        cumulativeEnergyExported: mwhToWh(state.cumulativeEnergyExported),
        periodicEnergyExported:   mwhToWh(state.periodicEnergyExported),
        timestamp: ts,
      };
    } catch (err) {
      console.error(`[DeviceManager] getEnergy failed for ${nodeId}:`, err);
      return nil;
    }
  }

  async getFullStatus(nodeId: string): Promise<{
    status: DeviceStatus;
    power:  PowerReading;
    energy: EnergyReading;
  }> {
    const [status, power, energy] = await Promise.all([
      this.getStatus(nodeId),
      this.getPower(nodeId),
      this.getEnergy(nodeId),
    ]);
    return { status, power, energy };
  }

  // ── Colour Lighting ──────────────────────────────────────────────────────

  async setColorTemperature(nodeId: string, mireds: number, transitionTime: number = 10): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    if (!this.hasCluster(ep, CLUSTER_IDS.COLOR_CONTROL)) {
      throw new Error(`Device ${nodeId} does not support Color Control.`);
    }
  
    const clampedMireds = Math.max(1, Math.min(65279, Math.round(mireds)));
  
    await ep.commandsOf(ColorControlClient).moveToColorTemperature({
      colorTemperatureMireds: clampedMireds,
      transitionTime,
      optionsMask:     { executeIfOff: false },
      optionsOverride: { executeIfOff: false },
    });
  
    this.broadcast({ event: "state_change", nodeId, attribute: "colorTemperatureMireds", value: clampedMireds });
    console.log(`[DeviceManager] COLOR-TEMP → ${nodeId} ${clampedMireds} mireds`);
  }


  /**
   * getColorTemperatureStatus()
   *
   * Reads current color temperature from subscription cache.
   * Returns both mireds (as stored in the cluster) and Kelvin (converted).
   * Returns null if cluster absent or cache not yet populated.
   */
  getColorTemperatureStatus(nodeId: string): {
    mireds:  number | null;
    kelvin:  number | null;
    minMireds: number | null;
    maxMireds: number | null;
    minKelvin: number | null;
    maxKelvin: number | null;
  } | null {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep || !this.hasCluster(ep, CLUSTER_IDS.COLOR_CONTROL)) return null;
  
    try {
      const state = ep.stateOf(ColorControlClient) as any;
      const mireds    = state.colorTemperatureMireds ?? null;
      const minMireds = state.colorTempPhysicalMinMireds ?? null;
      const maxMireds = state.colorTempPhysicalMaxMireds ?? null;
      return {
        mireds,
        kelvin:   mireds    ? Math.round(1_000_000 / mireds)    : null,
        minMireds,
        maxMireds,
        minKelvin: maxMireds ? Math.round(1_000_000 / maxMireds) : null,  // warmest
        maxKelvin: minMireds ? Math.round(1_000_000 / minMireds) : null,  // coolest
      };
    } catch {
      return null;
    }
  }
}

export const deviceManager = new DeviceManager();