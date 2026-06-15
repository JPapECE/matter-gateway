/**
 * CommandHandler.ts
 * Processes commands received from the cloud server and routes them
 * to DeviceManager, CommissioningService, or GroupsManager.
 */

import { deviceManager } from "../controller/DeviceManager.js";
import { config } from "../config.js";
import type { DatabaseService } from "../database/DatabaseService.js";
import type { CommissioningService } from "../controller/CommissioningService.js";
import type { GroupsManager } from "../controller/GroupsManager.js";
import type { CloudToGateway, ResponseMsg } from "../types/gateway-protocol.js";

class CommandHandler {
  private db: DatabaseService | null = null;
  private commissioningService: CommissioningService | null = null;
  private groupsManager: GroupsManager | null = null;

  public init(
    db: DatabaseService,
    commissioningService: CommissioningService,
    groupsManager: GroupsManager
  ): void {
    this.db = db;
    this.commissioningService = commissioningService;
    this.groupsManager = groupsManager;
  }

  public async handleCommand(msg: CloudToGateway & { type: "command" }): Promise<ResponseMsg> {
    const { requestId, action } = msg;

    if (!this.db || !this.commissioningService || !this.groupsManager) {
      return {
        type: "response",
        requestId,
        success: false,
        error: "Gateway services not fully initialized.",
      };
    }

    try {
      let data: any = null;

      switch (action) {
        // ── Device / System Actions (13) ──────────────────────────────────────
        case "on": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'on' command.");
          await deviceManager.turnOn(msg.nodeId);
          break;
        }
        case "off": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'off' command.");
          await deviceManager.turnOff(msg.nodeId);
          break;
        }
        case "toggle": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'toggle' command.");
          await deviceManager.toggle(msg.nodeId);
          break;
        }
        case "level": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'level' command.");
          if (!msg.payload) throw new Error("payload is required for 'level' command.");
          await deviceManager.setLevel(msg.nodeId, msg.payload.level, msg.payload.transitionTime);
          break;
        }
        case "level_move": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'level_move' command.");
          if (!msg.payload) throw new Error("payload is required for 'level_move' command.");
          await deviceManager.moveLevel(msg.nodeId, msg.payload.direction, msg.payload.rate);
          break;
        }
        case "level_stop": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'level_stop' command.");
          await deviceManager.stopLevel(msg.nodeId);
          break;
        }
        case "level_step": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'level_step' command.");
          if (!msg.payload) throw new Error("payload is required for 'level_step' command.");
          await deviceManager.stepLevel(
            msg.nodeId,
            msg.payload.direction,
            msg.payload.stepSize,
            msg.payload.transitionTime
          );
          break;
        }
        case "color_temperature": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'color_temperature' command.");
          if (!msg.payload) throw new Error("payload is required for 'color_temperature' command.");
          await deviceManager.setColorTemperature(
            msg.nodeId,
            msg.payload.mireds,
            msg.payload.transitionTime
          );
          break;
        }
        case "timed_on": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'timed_on' command.");
          if (!msg.payload) throw new Error("payload is required for 'timed_on' command.");
          data = await deviceManager.timedOn(
            msg.nodeId,
            msg.payload.onTime,
            msg.payload.offWaitTime
          );
          break;
        }
        case "commission": {
          if (!msg.payload) throw new Error("payload is required for 'commission' command.");
          const { pairingCode, name, type, wifi } = msg.payload;

          // Redact Wi-Fi password in console logging to preserve security
          const safePayload = {
            pairingCode,
            name,
            type,
            wifi: wifi ? { ssid: wifi.ssid, password: "[REDACTED]" } : undefined,
          };
          console.log("[CommandHandler] Executing commission with payload:", safePayload);

          data = await this.commissioningService.commission(pairingCode, name, type, wifi);
          break;
        }
        case "decommission": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'decommission' command.");
          await this.commissioningService.decommission(msg.nodeId);
          break;
        }
        case "discover_capabilities": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'discover_capabilities' command.");
          data = await deviceManager.discoverCapabilities(msg.nodeId);
          break;
        }
        case "ble_status": {
          const { matterController } = await import("../controller/MatterController.js");
          data = {
            bleSupported: matterController.bleSupported(),
            bleEnabled: config.bleEnabled,
            bleHciId: config.bleHciId,
          };
          break;
        }

        // ── Groups Actions (11) ──────────────────────────────────────────────
        case "list_groups": {
          const rawGroups = this.db.getAllGroups();
          data = rawGroups.map(({ epochKeyHex: _k, ...g }) => ({
            ...g,
            members: this.db!.getGroupMembers(g.groupId),
          }));
          break;
        }
        case "create_group": {
          if (!msg.payload) throw new Error("payload is required for 'create_group' command.");
          const { groupId, name } = msg.payload;
          const { epochKeyHex: _k, ...group } = await this.groupsManager.createGroup(groupId, name);
          data = { ...group, members: [] };
          break;
        }
        case "delete_group": {
          if (!msg.payload) throw new Error("payload is required for 'delete_group' command.");
          const { groupId } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);

          const members = this.db.getGroupMembers(groupId);
          await Promise.allSettled(
            members.map((nodeId) =>
              this.groupsManager!.removeDeviceFromGroup(nodeId, groupId).catch((err) =>
                console.warn(
                  `[CommandHandler] Could not send RemoveGroup to ${nodeId} during group delete:`,
                  err.message
                )
              )
            )
          );

          this.db.deleteGroup(groupId);
          data = { removed: groupId, devicesNotified: members.length };
          break;
        }
        case "rename_group": {
          if (!msg.payload) throw new Error("payload is required for 'rename_group' command.");
          const { groupId, name } = msg.payload;
          this.db.updateGroupName(groupId, name);
          break;
        }
        case "add_group_member": {
          if (!msg.payload) throw new Error("payload is required for 'add_group_member' command.");
          const { groupId, nodeId } = msg.payload;
          const group = this.db.getGroup(groupId);
          if (!group) throw new Error(`Group ${groupId} not found`);
          if (!this.db.getDevice(nodeId)) throw new Error(`Device ${nodeId} not found`);

          await this.groupsManager.addDeviceToGroup(nodeId, groupId, group.name, group.epochKeyHex);
          this.db.addGroupMember(groupId, nodeId);
          data = { groupId, nodeId, added: true };
          break;
        }
        case "remove_group_member": {
          if (!msg.payload) throw new Error("payload is required for 'remove_group_member' command.");
          const { groupId, nodeId } = msg.payload;
          if (!this.db.isGroupMember(groupId, nodeId)) {
            throw new Error(`Device ${nodeId} is not a member of group ${groupId}`);
          }

          try {
            await this.groupsManager.removeDeviceFromGroup(nodeId, groupId);
          } catch (err: any) {
            console.warn(
              `[CommandHandler] RemoveGroup to ${nodeId} failed (device offline) — removing from DB regardless:`,
              err.message
            );
          }

          this.db.removeGroupMember(groupId, nodeId);
          data = { groupId, nodeId, removed: true };
          break;
        }
        case "group_on": {
          if (!msg.payload) throw new Error("payload is required for 'group_on' command.");
          const { groupId } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);
          data = await this.groupsManager.groupOn(groupId);
          break;
        }
        case "group_off": {
          if (!msg.payload) throw new Error("payload is required for 'group_off' command.");
          const { groupId } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);
          data = await this.groupsManager.groupOff(groupId);
          break;
        }
        case "group_toggle": {
          if (!msg.payload) throw new Error("payload is required for 'group_toggle' command.");
          const { groupId } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);
          data = await this.groupsManager.groupToggle(groupId);
          break;
        }
        case "group_level": {
          if (!msg.payload) throw new Error("payload is required for 'group_level' command.");
          const { groupId, level, transitionTime } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);
          data = await this.groupsManager.groupSetLevel(groupId, level, transitionTime ?? 0);
          break;
        }
        case "group_color_temperature": {
          if (!msg.payload) throw new Error("payload is required for 'group_color_temperature' command.");
          const { groupId, mireds, transitionTime } = msg.payload;
          if (!this.db.getGroup(groupId)) throw new Error(`Group ${groupId} not found`);
          data = await this.groupsManager.groupSetColorTemperature(
            groupId,
            mireds,
            transitionTime ?? 10
          );
          break;
        }
        case "get_device_group_membership": {
          if (!msg.nodeId) throw new Error("nodeId is required for 'get_device_group_membership' command.");
          const membership = await this.groupsManager.getDeviceGroupMembership(msg.nodeId);
          data = {
            nodeId: msg.nodeId,
            capacity: membership.capacity,
            allGroups: membership.groupIds,
          };
          break;
        }
        default:
          throw new Error(`Unsupported command action: ${(action as any)}`);
      }

      return {
        type: "response",
        requestId,
        success: true,
        data,
      };
    } catch (err: any) {
      console.error(`[CommandHandler] Action "${action}" failed:`, err.message);
      return {
        type: "response",
        requestId,
        success: false,
        error: err.message || "Unknown error occurred.",
      };
    }
  }
}

export const commandHandler = new CommandHandler();
