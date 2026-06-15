/**
 * DatabaseService.ts
 * Gateway SQLite Service
 */

import Database from "better-sqlite3";
import { config } from "../config.js";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface DeviceRecord {
  nodeId:  string;
  name:    string;
  type:    string;
  addedAt: string;
}

export interface GroupRecord {
  groupId:     number;
  name:        string;
  createdAt:   string;
  epochKeyHex: string;
}

export interface EnergyBufferRecord {
  id:                       number;
  nodeId:                   string;
  activePower:              number | null;
  voltage:                  number | null;
  current:                  number | null;
  cumulativeEnergy:         number | null;
  periodicEnergy:           number | null;
  cumulativeEnergyExported: number | null;
  periodicEnergyExported:   number | null;
  recordedAt:               string;
  synced:                   number; // 0 or 1
}

export class DatabaseService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(config.dbPath);
    // Enforce foreign key constraints for cascade deletes
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // ── Migration ──────────────────────────────────────────────────────────────

  private migrate(): void {
    // ── device_cache table ───────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_cache (
        nodeId  TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        type    TEXT NOT NULL DEFAULT 'unknown',
        addedAt TEXT NOT NULL
      );
    `);

    // ── energy_buffer table ──────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS energy_buffer (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId                   TEXT    NOT NULL,
        activePower              REAL,
        voltage                  REAL,
        current                  REAL,
        cumulativeEnergy         REAL,
        periodicEnergy           REAL,
        cumulativeEnergyExported REAL,
        periodicEnergyExported   REAL,
        recordedAt               TEXT    NOT NULL,
        synced                   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_energy_buffer_nodeId ON energy_buffer(nodeId);
      CREATE INDEX IF NOT EXISTS idx_energy_buffer_synced ON energy_buffer(synced);
    `);

    // ── groups table ─────────────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        groupId     INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        createdAt   TEXT    NOT NULL,
        epochKeyHex TEXT
      );
    `);

    // ── group_members table ──────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        groupId INTEGER NOT NULL,
        nodeId  TEXT    NOT NULL,
        PRIMARY KEY (groupId, nodeId),
        FOREIGN KEY (groupId) REFERENCES groups(groupId) ON DELETE CASCADE,
        FOREIGN KEY (nodeId)  REFERENCES device_cache(nodeId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_group_members_nodeId ON group_members(nodeId);
      CREATE INDEX IF NOT EXISTS idx_group_members_groupId ON group_members(groupId);
    `);

    console.log("[DB] Gateway schema initialized successfully.");
  }

  // ── device_cache table ─────────────────────────────────────────────────────

  addDevice(nodeId: string, name: string, type: string): DeviceRecord {
    const record: DeviceRecord = {
      nodeId, name, type,
      addedAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO device_cache (nodeId, name, type, addedAt)
      VALUES (@nodeId, @name, @type, @addedAt)
    `).run(record);
    console.log(`[DB] Cache: Device added/replaced: "${name}" (nodeId=${nodeId})`);
    return record;
  }

  updateDeviceName(nodeId: string, newName: string): void {
    const result = this.db
      .prepare(`UPDATE device_cache SET name = ? WHERE nodeId = ?`)
      .run(newName, nodeId);
    if (result.changes === 0) throw new Error(`No device in cache with nodeId=${nodeId}`);
    console.log(`[DB] Cache: Renamed device ${nodeId} → "${newName}"`);
  }

  removeDevice(nodeId: string): void {
    this.db.prepare(`DELETE FROM device_cache WHERE nodeId = ?`).run(nodeId);
    console.log(`[DB] Cache: Device removed: nodeId=${nodeId}`);
  }

  getAllDevices(): DeviceRecord[] {
    return this.db
      .prepare(`SELECT * FROM device_cache ORDER BY addedAt`)
      .all() as DeviceRecord[];
  }

  getDevice(nodeId: string): DeviceRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM device_cache WHERE nodeId = ?`)
      .get(nodeId) as DeviceRecord | undefined;
  }

  // ── groups table ───────────────────────────────────────────────────────────

  createGroup(groupId: number, name: string, epochKeyHex: string): GroupRecord {
    const record: GroupRecord = {
      groupId,
      name,
      createdAt: new Date().toISOString(),
      epochKeyHex
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO groups (groupId, name, createdAt, epochKeyHex)
      VALUES (@groupId, @name, @createdAt, @epochKeyHex)
    `).run(record);
    console.log(`[DB] Group created/replaced: "${name}" (groupId=${groupId})`);
    return record;
  }

  updateGroupEpochKey(groupId: number, epochKeyHex: string): void {
    const result = this.db
      .prepare(`UPDATE groups SET epochKeyHex = ? WHERE groupId = ?`)
      .run(epochKeyHex, groupId);
    if (result.changes === 0) throw new Error(`No group with groupId=${groupId}`);
  }

  getGroup(groupId: number): GroupRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM groups WHERE groupId = ?`)
      .get(groupId) as GroupRecord | undefined;
  }

  getAllGroups(): GroupRecord[] {
    return this.db
      .prepare(`SELECT * FROM groups ORDER BY groupId`)
      .all() as GroupRecord[];
  }

  deleteGroup(groupId: number): void {
    this.db.prepare(`DELETE FROM groups WHERE groupId = ?`).run(groupId);
    console.log(`[DB] Group deleted: groupId=${groupId}`);
  }

  updateGroupName(groupId: number, name: string): void {
    const result = this.db
      .prepare(`UPDATE groups SET name = ? WHERE groupId = ?`)
      .run(name, groupId);
    if (result.changes === 0) throw new Error(`No group with groupId=${groupId}`);
    console.log(`[DB] Group ${groupId} renamed → "${name}"`);
  }

  // ── group_members table ────────────────────────────────────────────────────

  addGroupMember(groupId: number, nodeId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO group_members (groupId, nodeId) VALUES (?, ?)`)
      .run(groupId, nodeId);
  }

  removeGroupMember(groupId: number, nodeId: string): void {
    this.db
      .prepare(`DELETE FROM group_members WHERE groupId = ? AND nodeId = ?`)
      .run(groupId, nodeId);
  }

  getGroupMembers(groupId: number): string[] {
    const rows = this.db
      .prepare(`SELECT nodeId FROM group_members WHERE groupId = ? ORDER BY nodeId`)
      .all(groupId) as { nodeId: string }[];
    return rows.map((r) => r.nodeId);
  }

  getGroupsForDevice(nodeId: string): GroupRecord[] {
    return this.db.prepare(`
      SELECT g.*
        FROM groups g
        JOIN group_members m ON g.groupId = m.groupId
       WHERE m.nodeId = ?
       ORDER BY g.groupId
    `).all(nodeId) as GroupRecord[];
  }

  isGroupMember(groupId: number, nodeId: string): boolean {
    return this.db
      .prepare(`SELECT 1 FROM group_members WHERE groupId = ? AND nodeId = ?`)
      .get(groupId, nodeId) !== undefined;
  }

  // ── energy_buffer table ───────────────────────────────────────────────────

  saveEnergyReading(
    nodeId: string,
    power: {
      activePower: number | null;
      voltage:     number | null;
      current:     number | null;
    },
    energy: {
      cumulativeEnergy:         number | null;
      periodicEnergy:           number | null;
      cumulativeEnergyExported: number | null;
      periodicEnergyExported:   number | null;
    }
  ): void {
    this.db.prepare(`
      INSERT INTO energy_buffer
        (nodeId, activePower, voltage, current,
         cumulativeEnergy, periodicEnergy,
         cumulativeEnergyExported, periodicEnergyExported,
         recordedAt, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      nodeId,
      power.activePower,
      power.voltage,
      power.current,
      energy.cumulativeEnergy,
      energy.periodicEnergy,
      energy.cumulativeEnergyExported,
      energy.periodicEnergyExported,
      new Date().toISOString()
    );
  }

  getUnsyncedEnergyReadings(): EnergyBufferRecord[] {
    return this.db
      .prepare(`SELECT * FROM energy_buffer WHERE synced = 0 ORDER BY recordedAt ASC`)
      .all() as EnergyBufferRecord[];
  }

  markEnergyReadingsAsSynced(ids: number[]): void {
    if (ids.length === 0) return;
    const info = this.db.prepare(
      `UPDATE energy_buffer SET synced = 1 WHERE id IN (${ids.join(",")})`
    ).run();
    console.log(`[DB] Marked ${info.changes} energy readings as synced.`);
  }

  clearSyncedEnergyReadings(): void {
    const info = this.db.prepare(`DELETE FROM energy_buffer WHERE synced = 1`).run();
    if (info.changes > 0) {
      console.log(`[DB] Cleared ${info.changes} synced energy readings from buffer.`);
    }
  }
}
