/**
 * EventForwarder.ts
 * Forwards local gateway events to the cloud WebSocket server.
 * Intercepts energy_snapshots to buffer them in SQLite.
 */

import { gatewayBridge } from "./GatewayBridge.js";
import type { DatabaseService } from "../database/DatabaseService.js";
import type { EventMsg } from "../types/gateway-protocol.js";

class EventForwarder {
  private db: DatabaseService | null = null;
  private isSyncing = false;
  private flushInterval: NodeJS.Timeout | null = null;

  public init(db: DatabaseService): void {
    this.db = db;
    // Periodically flush and clean the SQLite buffer (every 15s)
    this.flushInterval = setInterval(() => this.flushUnsyncedReadings(), 15000);
  }

  public forward(payload: any): void {
    if (!this.db) return;

    // 1. Intercept energy snapshots to write them to SQLite first (resilience)
    if (payload.event === "energy_snapshot") {
      const { nodeId, power, energy } = payload;
      try {
        this.db.saveEnergyReading(nodeId, power, energy);
      } catch (err: any) {
        console.error("[EventForwarder] Failed to write energy reading to SQLite buffer:", err.message);
      }

      // Trigger a flush immediately
      this.flushUnsyncedReadings();
      return;
    }

    // 2. Format all other events (online/offline, state changes) and send immediately
    const eventMsg: EventMsg = {
      type: "event",
      event: payload.event,
      ...payload,
    };

    if (gatewayBridge.isConnectedAndAuthenticated()) {
      gatewayBridge.send(eventMsg);
    } else {
      console.warn(`[EventForwarder] Offline: Event of type "${payload.event}" dropped.`);
    }
  }

  public async flushUnsyncedReadings(): Promise<void> {
    if (!this.db || this.isSyncing) return;
    if (!gatewayBridge.isConnectedAndAuthenticated()) return;

    this.isSyncing = true;
    try {
      const unsynced = this.db.getUnsyncedEnergyReadings();
      if (unsynced.length === 0) {
        this.db.clearSyncedEnergyReadings();
        this.isSyncing = false;
        return;
      }

      console.log(`[EventForwarder] Syncing ${unsynced.length} buffered energy readings with cloud...`);

      const successfullySyncedIds: number[] = [];

      for (const record of unsynced) {
        // Enforce active WSS connection before sending each record
        if (!gatewayBridge.isConnectedAndAuthenticated()) {
          break;
        }

        const payload = {
          event: "energy_snapshot" as const,
          nodeId: record.nodeId,
          power: {
            activePower: record.activePower,
            voltage: record.voltage,
            current: record.current,
            timestamp: record.recordedAt,
          },
          energy: {
            cumulativeEnergy: record.cumulativeEnergy,
            periodicEnergy: record.periodicEnergy,
            cumulativeEnergyExported: record.cumulativeEnergyExported,
            periodicEnergyExported: record.periodicEnergyExported,
            timestamp: record.recordedAt,
          },
        };

        const eventMsg: EventMsg = {
          type: "event",
          ...payload,
        };

        gatewayBridge.send(eventMsg);
        successfullySyncedIds.push(record.id);
      }

      if (successfullySyncedIds.length > 0) {
        this.db.markEnergyReadingsAsSynced(successfullySyncedIds);
        this.db.clearSyncedEnergyReadings();
      }
    } catch (err: any) {
      console.error("[EventForwarder] Error while flushing unsynced readings:", err.message);
    } finally {
      this.isSyncing = false;
    }
  }

  public shutdown(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}

export const eventForwarder = new EventForwarder();
