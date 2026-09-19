/**
 * LocalApiServer.ts
 *
 * A self-contained HTTP + WebSocket server that the gateway runs on the local
 * network (port 4000 by default).  The Expo app connects here directly when
 * it detects that it is on the same LAN as the gateway, bypassing the cloud.
 *
 * API surface mirrors matter-cloud/src/api/routes.ts so the frontend client
 * needs no changes — only the base URL is switched.
 *
 * Authentication:
 *   REST  — Bearer <localApiKey> in Authorization header
 *   WS    — ?token=<localApiKey> query param  (same pattern as cloud /ws)
 *
 * Energy history endpoints return [] / empty stats — that data lives in
 * the cloud's PostgreSQL and is not available locally.
 */

import http from "http";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import os from "os";

import { config } from "../config.js";
import { deviceManager } from "../controller/DeviceManager.js";
import { commandHandler } from "../bridge/CommandHandler.js";
import type { DatabaseService } from "../database/DatabaseService.js";
import type { CommissioningService } from "../controller/CommissioningService.js";
import type { GroupsManager } from "../controller/GroupsManager.js";

// ── Local WebSocket client set (for event broadcast) ─────────────────────────
const localWsClients = new Set<WebSocket>();

/** Broadcast a JSON payload to every connected local WS client. */
export function broadcastLocal(payload: object): void {
  const msg = JSON.stringify(payload);
  for (const ws of localWsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function handleError(err: any, res: Response): void {
  const msg = err?.message ?? String(err);
  if (msg.includes("not found") || msg.includes("404")) {
    res.status(404).json({ error: msg });
  } else {
    res.status(500).json({ error: msg });
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireLocalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!config.localApiKey || token !== config.localApiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Build Express app ─────────────────────────────────────────────────────────

function buildApp(
  db: DatabaseService,
  commissioningService: CommissioningService,
  groupsManager: GroupsManager
): express.Application {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Public health check — no auth required
  app.get("/health", (_req, res) => {
    res.json({ ok: true, localMode: true, timestamp: new Date().toISOString() });
  });

  // All /api routes require auth
  app.use("/api", requireLocalAuth);

  // ── Devices ──────────────────────────────────────────────────────────────

  app.get("/api/devices", (_req, res) => {
    try {
      const devices = db.getAllDevices().map((d) => ({
        nodeId:   d.nodeId,
        name:     d.name,
        type:     d.type,
        addedAt:  d.addedAt,
        online:   true,   // gateway only tracks commissioned devices; assume online
        on:       null,
        level:    null,
        capabilities: null,
      }));
      res.json(devices);
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get("/api/devices/:id/status", async (req, res) => {
    const { id } = req.params;
    try {
      const device = db.getDevice(id);
      if (!device) { res.status(404).json({ error: `Device ${id} not found` }); return; }
      res.json({ nodeId: id, online: true, on: null, level: null });
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get("/api/devices/:id/full-status", async (req, res) => {
    const { id } = req.params;
    try {
      const device = db.getDevice(id);
      if (!device) { res.status(404).json({ error: `Device ${id} not found` }); return; }

      // Read live power + energy directly from the Matter stack
      const [power, energy] = await Promise.all([
        deviceManager.getPower(id).catch(() => ({ activePower: null, voltage: null, current: null, timestamp: new Date().toISOString() })),
        deviceManager.getEnergy(id).catch(() => ({ cumulativeEnergy: null, periodicEnergy: null, cumulativeEnergyExported: null, periodicEnergyExported: null, timestamp: new Date().toISOString() })),
      ]);

      res.json({
        status: { nodeId: id, online: true, on: null, level: null },
        power:  { nodeId: id, ...power },
        energy: { nodeId: id, ...energy },
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get("/api/devices/:id/capabilities", async (req, res) => {
    const { id } = req.params;
    try {
      const caps = await deviceManager.discoverCapabilities(id);
      res.json(caps);
    } catch (err) {
      handleError(err, res);
    }
  });

  // Energy history — read from local 24h SQLite buffer
  app.get("/api/devices/:id/energy/history", (req, res) => {
    const { id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const since = req.query.since as string | undefined;
    try {
      const history = db.getEnergyHistory(id, limit, since).map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        activePower: r.activePower,
        voltage: r.voltage,
        current: r.current,
        frequency: r.frequency,
        powerFactor: r.powerFactor,
        cumulativeEnergy: r.cumulativeEnergy,
        periodicEnergy: r.periodicEnergy,
        cumulativeEnergyExported: r.cumulativeEnergyExported,
        periodicEnergyExported: r.periodicEnergyExported,
        recordedAt: r.recordedAt,
      }));
      res.json(history);
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get("/api/devices/:id/energy/stats", (req, res) => {
    const { id } = req.params;
    const since = req.query.since as string;
    if (!since) {
      res.status(400).json({ error: "since query parameter is required" });
      return;
    }
    try {
      const stats = db.getEnergyStats(id, since);
      res.json({
        ...stats,
        since,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Control commands ──────────────────────────────────────────────────────

  app.post("/api/devices/:id/on", async (req, res) => {
    const { id } = req.params;
    try { await deviceManager.turnOn(id); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/off", async (req, res) => {
    const { id } = req.params;
    try { await deviceManager.turnOff(id); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/toggle", async (req, res) => {
    const { id } = req.params;
    try { await deviceManager.toggle(id); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/level", async (req, res) => {
    const { id } = req.params;
    const { level, transitionTime } = req.body;
    if (typeof level !== "number" || level < 1 || level > 254) {
      res.status(400).json({ error: "level must be 1–254" }); return;
    }
    try { await deviceManager.setLevel(id, level, transitionTime); res.json({ ok: true, level }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/level/step", async (req, res) => {
    const { id } = req.params;
    const { direction, stepSize, transitionTime } = req.body;
    try { await deviceManager.stepLevel(id, direction, stepSize, transitionTime); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/level/move", async (req, res) => {
    const { id } = req.params;
    const { direction, rate } = req.body;
    try { await deviceManager.moveLevel(id, direction, rate); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/level/stop", async (req, res) => {
    const { id } = req.params;
    try { await deviceManager.stopLevel(id); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/timed-on", async (req, res) => {
    const { id } = req.params;
    const { onTime, offWaitTime } = req.body;
    if (typeof onTime !== "number" || onTime <= 0) {
      res.status(400).json({ error: "onTime must be a positive number" }); return;
    }
    try {
      const data = await deviceManager.timedOn(id, onTime, offWaitTime ?? 0);
      res.json({ ok: true, data });
    } catch (err) { handleError(err, res); }
  });

  app.post("/api/devices/:id/color-temperature", async (req, res) => {
    const { id } = req.params;
    let { mireds, kelvin, transitionTime } = req.body;
    if (mireds == null && kelvin == null) {
      res.status(400).json({ error: "mireds or kelvin required" }); return;
    }
    if (mireds == null && kelvin != null) mireds = Math.round(1_000_000 / kelvin);
    try {
      await deviceManager.setColorTemperature(id, mireds, transitionTime);
      res.json({ ok: true, mireds, kelvin: Math.round(1_000_000 / mireds) });
    } catch (err) { handleError(err, res); }
  });

  app.get("/api/devices/:id/color-temperature", async (req, res) => {
    const { id } = req.params;
    try {
      const caps = await deviceManager.discoverCapabilities(id).catch(() => null);
      const minMireds = (caps as any)?.minMireds ?? null;
      const maxMireds = (caps as any)?.maxMireds ?? null;
      res.json({
        nodeId: id,
        mireds: null, kelvin: null,
        minMireds, maxMireds,
        minKelvin: maxMireds ? Math.round(1_000_000 / maxMireds) : null,
        maxKelvin: minMireds ? Math.round(1_000_000 / minMireds) : null,
      });
    } catch (err) { handleError(err, res); }
  });

  app.patch("/api/devices/:id/name", (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" }); return;
    }
    try { db.updateDeviceName(id, name.trim()); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.delete("/api/devices/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await commissioningService.decommission(id);
      res.json({ removed: id });
    } catch (err) { handleError(err, res); }
  });

  app.post("/api/commission", async (req, res) => {
    const { pairingCode, name, type, wifi } = req.body;
    if (!pairingCode || !name) {
      res.status(400).json({ error: "pairingCode and name are required" }); return;
    }
    try {
      const nodeId = await commissioningService.commission(pairingCode, name, type, wifi);
      res.status(201).json({ nodeId, name, success: true });
    } catch (err) { handleError(err, res); }
  });

  // ── Groups ────────────────────────────────────────────────────────────────

  app.get("/api/groups", (_req, res) => {
    try {
      const groups = db.getAllGroups().map(({ epochKeyHex: _, ...g }) => ({
        ...g,
        members: db.getGroupMembers(g.groupId),
      }));
      res.json(groups);
    } catch (err) { handleError(err, res); }
  });

  app.post("/api/groups", async (req, res) => {
    const { groupId, name } = req.body;
    try {
      const { epochKeyHex: _, ...group } = await groupsManager.createGroup(groupId, name);
      res.json({ ...group, members: [] });
    } catch (err) { handleError(err, res); }
  });

  app.get("/api/groups/:id", (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    try {
      const group = db.getGroup(groupId);
      if (!group) { res.status(404).json({ error: "Group not found" }); return; }
      const { epochKeyHex: _, ...g } = group;
      res.json({ ...g, members: db.getGroupMembers(groupId) });
    } catch (err) { handleError(err, res); }
  });

  app.delete("/api/groups/:id", async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    try {
      const members = db.getGroupMembers(groupId);
      await Promise.allSettled(members.map((nodeId) => groupsManager.removeDeviceFromGroup(nodeId, groupId).catch(() => {})));
      db.deleteGroup(groupId);
      res.json({ removed: groupId });
    } catch (err) { handleError(err, res); }
  });

  app.post("/api/groups/:id/members/:nodeId", async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const { nodeId } = req.params;
    try {
      const group = db.getGroup(groupId);
      if (!group) { res.status(404).json({ error: "Group not found" }); return; }
      await groupsManager.addDeviceToGroup(nodeId, groupId, group.name, group.epochKeyHex);
      db.addGroupMember(groupId, nodeId);
      res.json({ groupId, nodeId, added: true });
    } catch (err) { handleError(err, res); }
  });

  app.delete("/api/groups/:id/members/:nodeId", async (req, res) => {
    const groupId = parseInt(req.params.id, 10);
    const { nodeId } = req.params;
    try {
      await groupsManager.removeDeviceFromGroup(nodeId, groupId).catch(() => {});
      db.removeGroupMember(groupId, nodeId);
      res.json({ ok: true });
    } catch (err) { handleError(err, res); }
  });

  app.post("/api/groups/:id/on",     async (req, res) => { try { await groupsManager.groupOn(parseInt(req.params.id, 10));     res.json({ ok: true }); } catch (err) { handleError(err, res); } });
  app.post("/api/groups/:id/off",    async (req, res) => { try { await groupsManager.groupOff(parseInt(req.params.id, 10));    res.json({ ok: true }); } catch (err) { handleError(err, res); } });
  app.post("/api/groups/:id/toggle", async (req, res) => { try { await groupsManager.groupToggle(parseInt(req.params.id, 10)); res.json({ ok: true }); } catch (err) { handleError(err, res); } });

  app.post("/api/groups/:id/level", async (req, res) => {
    const { level, transitionTime } = req.body;
    try { await groupsManager.groupSetLevel(parseInt(req.params.id, 10), level, transitionTime ?? 0); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  app.post("/api/groups/:id/color-temperature", async (req, res) => {
    const { mireds, transitionTime } = req.body;
    try { await groupsManager.groupSetColorTemperature(parseInt(req.params.id, 10), mireds, transitionTime ?? 10); res.json({ ok: true }); }
    catch (err) { handleError(err, res); }
  });

  return app;
}

// ── Detect local LAN IP ───────────────────────────────────────────────────────

export function getLocalIp(): string | null {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

// ── Start the server ──────────────────────────────────────────────────────────

export class LocalApiServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  public start(
    db: DatabaseService,
    commissioningService: CommissioningService,
    groupsManager: GroupsManager
  ): void {
    const app = buildApp(db, commissioningService, groupsManager);
    this.httpServer = http.createServer(app);

    // WebSocket upgrade — /ws path, token auth via query param
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      if (url.pathname !== "/ws") { socket.destroy(); return; }

      const token = url.searchParams.get("token") ?? "";
      if (!config.localApiKey || token !== config.localApiKey) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws);
      });
    });

    this.wss.on("connection", (ws) => {
      localWsClients.add(ws);
      // Immediately send a gateway_status: connected event so the app knows the WS is live
      ws.send(JSON.stringify({ event: "gateway_status", status: "connected" }));

      ws.on("close", () => localWsClients.delete(ws));
      ws.on("error", () => localWsClients.delete(ws));
    });

    const port = config.localApiPort;
    this.httpServer.listen(port, () => {
      const localIp = getLocalIp();
      console.log(`[LocalApiServer] Listening on port ${port}  (http://${localIp ?? "localhost"}:${port})`);
    });
  }

  public stop(): void {
    for (const ws of localWsClients) ws.close();
    localWsClients.clear();
    this.wss?.close();
    this.httpServer?.close();
  }
}

export const localApiServer = new LocalApiServer();
