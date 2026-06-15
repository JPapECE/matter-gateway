/**
 * GatewayBridge.ts
 * Manages the outbound WebSocket connection to the cloud server.
 */

import WebSocket from "ws";
import { config } from "../config.js";
import { DatabaseService } from "../database/DatabaseService.js";
import { commandHandler } from "./CommandHandler.js";
import type { CommissioningService } from "../controller/CommissioningService.js";
import type { GroupsManager } from "../controller/GroupsManager.js";
import type { GatewayToCloud, CloudToGateway } from "../types/gateway-protocol.js";

class GatewayBridge {
  private ws: WebSocket | null = null;
  private db: DatabaseService | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isAuthenticated = false;
  private isConnecting = false;

  public init(
    db: DatabaseService,
    commissioningService: CommissioningService,
    groupsManager: GroupsManager
  ): void {
    this.db = db;
    commandHandler.init(db, commissioningService, groupsManager);
    this.connect();
  }

  private connect(): void {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    if (!config.cloudWsUrl) {
      console.error("[GatewayBridge] CLOUD_WS_URL is not configured.");
      return;
    }

    this.isConnecting = true;
    console.log(`[GatewayBridge] Connecting to cloud: ${config.cloudWsUrl}`);

    this.ws = new WebSocket(config.cloudWsUrl);

    this.ws.on("open", () => {
      this.isConnecting = false;
      this.reconnectDelay = 1000; // Reset backoff delay
      console.log("[GatewayBridge] WebSocket connection established. Sending auth token...");
      this.sendAuth();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleIncomingMessage(message);
      } catch (err) {
        console.error("[GatewayBridge] Failed to parse message:", err);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.isConnecting = false;
      this.handleDisconnect(`Closed (code=${code}, reason=${reason.toString()})`);
    });

    this.ws.on("error", (err) => {
      this.isConnecting = false;
      console.error("[GatewayBridge] WebSocket error:", err.message);
      // 'close' event will follow error
    });
  }

  private handleDisconnect(reason: string): void {
    console.warn(`[GatewayBridge] Connection lost: ${reason}`);
    this.isAuthenticated = false;
    this.stopHeartbeat();

    // Reconnect with exponential backoff
    console.log(`[GatewayBridge] Retrying connection in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  private sendAuth(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const authPayload = {
      type: "auth" as const,
      token: config.gatewaySecretToken || "",
    };
    this.ws.send(JSON.stringify(authPayload));
  }

  private sendInitState(): void {
    if (!this.db) return;

    console.log("[GatewayBridge] Preparing to send init_state...");
    const rawDevices = this.db.getAllDevices();
    const rawGroups = this.db.getAllGroups();

    const devices = rawDevices.map((d) => ({
      nodeId: d.nodeId,
      name: d.name,
      type: d.type,
      addedAt: d.addedAt,
    }));

    const groups = rawGroups.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      members: this.db!.getGroupMembers(g.groupId),
    }));

    const initStatePayload = {
      type: "init_state" as const,
      devices,
      groups,
    };

    this.send(initStatePayload);
    console.log(`[GatewayBridge] Sent init_state. Devices: ${devices.length}, Groups: ${groups.length}`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      const heartbeatMsg = {
        type: "heartbeat" as const,
        timestamp: new Date().toISOString(),
      };
      this.send(heartbeatMsg);
    }, 30000);
    console.log("[GatewayBridge] Heartbeat loop started (30s interval).");
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleIncomingMessage(msg: any): void {
    // 1. Handle Auth Handshake Acknowledgement
    if (msg.type === "auth_ok" || (msg.type === "auth" && msg.success === true)) {
      console.log("[GatewayBridge] Authentication successful.");
      this.isAuthenticated = true;
      this.sendInitState();
      this.startHeartbeat();
      return;
    }

    // 2. Enforce authentication for all other actions
    if (!this.isAuthenticated) {
      console.warn("[GatewayBridge] Ignored incoming message prior to authentication:", msg);
      return;
    }

    // 3. Handle commands
    if (msg.type === "command") {
      commandHandler.handleCommand(msg as CloudToGateway & { type: "command" })
        .then((response) => {
          this.send(response);
        })
        .catch((err) => {
          console.error("[GatewayBridge] Command handler error:", err);
        });
      return;
    }

    // 4. Handle Ping
    if (msg.type === "ping") {
      // Respond to ping if necessary, or just log
      console.log("[GatewayBridge] Ping received from cloud.");
      return;
    }

    console.warn("[GatewayBridge] Unknown message type:", msg.type);
  }

  /**
   * Sends a typed payload to the cloud WebSocket server.
   */
  public send(payload: GatewayToCloud): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[GatewayBridge] Cannot send, WebSocket is not open.");
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  public isConnectedAndAuthenticated(): boolean {
    return this.isAuthenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const gatewayBridge = new GatewayBridge();
