/**
 * GroupsManager.ts
 *
 * ─── Groups cluster (0x0004) overview ────────────────────────────────────────
 * The Groups cluster is fabric-scoped: each fabric manages its own group
 * membership table independently inside every device.
 *
 * Per-device commands (unicast to individual device's Groups cluster on ep1):
 *   AddGroup            — tells the device it belongs to <groupId>
 *   RemoveGroup         — removes the device from <groupId>
 *   RemoveAllGroups     — clears all group memberships on the device
 *   GetGroupMembership  — reads the device's own group list (verification)
 *
 * Group fan-out commands (parallel unicast to all DB-tracked members):
 *   groupOn / groupOff / groupToggle — On/Off cluster commands to all members
 *   groupSetLevel                    — Level Control to all members
 *   groupSetColorTemperature         — Color Control (CT) to all members
 *
 * ─── Why fan-out instead of Matter multicast? ────────────────────────────────
 * Matter multicast requires GroupKeyManagement key-set writes on BOTH the
 * controller's own root endpoint AND each target device's root endpoint.
 * The controller-side fan-out (parallel unicast via Promise.allSettled) is
 * functionally equivalent for a hub topology — all plugs are unicast targets —
 * and avoids relying on GroupKeyManagement for actual message delivery.
 *
 * However, Matter spec §1.3.7.1 requires that the device has a valid
 * GroupKeySet (written via KeySetWrite) AND a GroupKeyMap entry (written via
 * attribute write) BEFORE it will accept an AddGroup command. The Shelly Plug
 * S Gen3 enforces this and returns UNSUPPORTED_ACCESS (0x7E) otherwise.
 *
 * The provisioning sequence for each AddGroup call is therefore:
 *   1. KeySetWrite   → device ep0 GroupKeyManagement cluster
 *   2. GroupKeyMap   → device ep0 (write attribute, replaces all fabric entries)
 *   3. (controller) → direct state mutation on controller's GroupKeyManagementBehavior
 *   4. AddGroup      → device ep1 Groups cluster
 *
 * ─── Membership tracking ─────────────────────────────────────────────────────
 * The controller tracks group membership in its own SQLite DB (group_members
 * table). This is the source of truth for fan-out lookups.
 * AddGroup/RemoveGroup are ALSO sent to the device so its Groups cluster stays
 * in sync (required by the Matter spec for correct group-addressed message
 * filtering when another controller eventually uses multicast).
 */

import { randomBytes }            from "crypto";
import { GroupsClient }            from "@matter/main/behaviors/groups";
import {
  GroupKeyManagementClient,
  GroupKeyManagementBehavior,
}                                  from "@matter/main/behaviors/group-key-management";
import { FabricManager, Write, WriteResult } from "@matter/protocol";
import { EndpointNumber, FabricIndex, GroupId } from "@matter/types";
import { matterController }        from "./MatterController.js";
import { deviceManager }           from "./DeviceManager.js";
import type { DatabaseService, GroupRecord } from "../database/DatabaseService.js";

// ── GroupKeyManagement policy constants (Matter Application Cluster Spec §1.3.7) ──
// Imported by value to avoid the deep @matter/types/clusters sub-path import.
const GKM_SECURITY_TRUST_FIRST   = 0;  // GroupKeySecurityPolicy.TrustFirst
const GKM_MULTICAST_PER_GROUP_ID = 0;  // GroupKeyMulticastPolicy.PerGroupId

// ── Result type for parallel fan-out operations ────────────────────────────
export interface FanOutResult {
  succeeded: string[];
  failed:    string[];
}

// ── Matter Groups status codes (spec §1.3.7) ──────────────────────────────
const STATUS_SUCCESS          = 0x00;
const STATUS_DUPLICATE_EXISTS = 0x8A;   // AddGroup: device already in group — acceptable
const STATUS_NOT_FOUND        = 0x8B;   // RemoveGroup: group not found — acceptable

export class GroupsManager {
  constructor(private db: DatabaseService) {}

  // ── Internal helpers ───────────────────────────────────────────────────────

  private getPeer(nodeId: string): any | null {
    return matterController.node.peers.get(nodeId) ?? null;
  }

  /**
   * getPrimaryEndpoint() — returns ep1 (or first non-root endpoint).
   * Groups cluster (AddGroup/RemoveGroup) lives on ep1 for Shelly Plug S.
   */
  private getPrimaryEndpoint(nodeId: string): any | null {
    const peer = this.getPeer(nodeId);
    if (!peer) return null;

    const parts = (peer as any).parts;
    if (!parts) return null;

    const byKey = parts.get?.("ep1") ?? parts.get?.("1");
    if (byKey !== undefined) return byKey;

    let first: any = null;
    try {
      parts.forEach((part: any) => {
        if (first) return;
        const id = String(part?.id ?? part?.number ?? "");
        if (id !== "root" && id !== "ep0" && id !== "0" && id !== "") first = part;
      });
    } catch { /* Parts not yet populated */ }

    return first;
  }

  // ── Group creation ─────────────────────────────────────────────────────────

  /**
   * createGroup()
   *
   * Generates a random 16-byte AES epoch key for the group, persists it to DB,
   * and provisions the controller's own GroupKeyManagement cluster so the
   * controller knows about the key (required for protocol correctness even
   * though we use unicast fan-out rather than actual multicast).
   */
  async createGroup(groupId: number, name: string): Promise<GroupRecord> {
    const epochKey    = randomBytes(16);
    const epochKeyHex = epochKey.toString("hex");
    const record      = this.db.createGroup(groupId, name, epochKeyHex);
    await this.provisionControllerGroupKey(groupId, groupId, epochKey);
    return record;
  }

  // ── GroupKeyManagement provisioning ───────────────────────────────────────

  /**
   * provisionControllerGroupKey()
   *
   * Writes the GroupKeySet + GroupKeyMap entry into the CONTROLLER's own
   * GroupKeyManagement cluster (ep0) via direct state mutation.
   *
   * The GroupKeyManagementServer.keySetWrite() command uses assertRemoteActor()
   * and cannot be invoked locally, so we bypass it by writing state directly
   * inside a node.act() context, which is the matter.js-sanctioned way to
   * mutate server state without a session.
   */
  private async provisionControllerGroupKey(
    groupId:       number,
    groupKeySetId: number,
    epochKey:      Uint8Array,
  ): Promise<void> {
    const fabrics = matterController.node.env.get(FabricManager);
    let fabricIndex = 1;  // safe default; overwritten by the loop below
    for (const fabric of (fabrics as any)) {
      fabricIndex = fabric.fabricIndex;
      break;
    }

    await matterController.node.act(async (agent: any) => {
      const gkm = agent.get(GroupKeyManagementBehavior) as any;

      // Upsert GroupKeySet entry for this fabric + keySetId
      const existingIdx = (gkm.state.groupKeySets as any[]).findIndex(
        (ks: any) => ks.fabricIndex === fabricIndex && ks.groupKeySetId === groupKeySetId
      );
      const keySet = {
        groupKeySetId,
        groupKeySecurityPolicy:
          GKM_SECURITY_TRUST_FIRST,
        epochKey0:       epochKey,
        epochStartTime0: BigInt(Date.now()) * 1000n,  // Unix microseconds — must exceed MATTER_EPOCH_OFFSET
        epochKey1:       null,
        epochStartTime1: null,
        epochKey2:       null,
        epochStartTime2: null,
        groupKeyMulticastPolicy:
          GKM_MULTICAST_PER_GROUP_ID,
        fabricIndex:     FabricIndex(fabricIndex),
      };

      if (existingIdx !== -1) {
        gkm.state.groupKeySets[existingIdx] = keySet;
      } else {
        gkm.state.groupKeySets = [...gkm.state.groupKeySets, keySet];
      }

      // Upsert GroupKeyMap entry: groupId → groupKeySetId (same value in our design)
      const filteredMap = (gkm.state.groupKeyMap as any[]).filter(
        (m: any) => !(m.fabricIndex === fabricIndex && m.groupId === groupId)
      );
      gkm.state.groupKeyMap = [
        ...filteredMap,
        { groupId, groupKeySetId, fabricIndex: FabricIndex(fabricIndex) },
      ];
    });

    console.log(
      `[Groups] Controller: provisioned GroupKeySet id=${groupKeySetId} ` +
      `fabricIndex=${fabricIndex}`
    );
  }

  /**
   * provisionDeviceGroupKey()
   *
   * Sends KeySetWrite + GroupKeyMap write to the TARGET DEVICE's ep0.
   *
   * Per Matter spec §1.3.7.1, this must happen before AddGroup will be
   * accepted by the device. Shelly Plug S Gen3 returns UNSUPPORTED_ACCESS
   * (0x7E) from AddGroup if this provisioning is skipped.
   *
   * @param nodeId       The target device's node ID
   * @param groupId      The group being added
   * @param groupKeySetId  The key set ID (= groupId in our design)
   * @param epochKey     Raw 16-byte AES-128 epoch key
   */
  private async provisionDeviceGroupKey(
    nodeId:        string,
    groupId:       number,
    groupKeySetId: number,
    epochKey:      Uint8Array,
  ): Promise<void> {
    const peer = this.getPeer(nodeId);
    if (!peer) throw new Error(`Device ${nodeId} not found in fabric.`);

    // ── 1. KeySetWrite ────────────────────────────────────────────────────────
    // peer IS endpoint 0 (root) — GroupKeyManagement always lives on ep0.
    await (peer as any).commandsOf(GroupKeyManagementClient).keySetWrite({
      groupKeySet: {
        groupKeySetId,
        groupKeySecurityPolicy:
          GKM_SECURITY_TRUST_FIRST,
        epochKey0:       epochKey,
        epochStartTime0: BigInt(Date.now()) * 1000n,
        epochKey1:       null,
        epochStartTime1: null,
        epochKey2:       null,
        epochStartTime2: null,
        groupKeyMulticastPolicy:
          GKM_MULTICAST_PER_GROUP_ID,
      },
    });
    console.log(`[Groups] KeySetWrite → ${nodeId} groupKeySetId=${groupKeySetId}`);

    // ── 2. Write GroupKeyMap attribute on the device ──────────────────────────
    // Build the full map: all existing group memberships for this device + the
    // new one. We must write ALL entries for our fabric in one call (the write
    // replaces all fabric-scoped entries). FabricIndex(0) = current fabric;
    // the device fills in the real fabricIndex from the CASE session.
    const existingGroups = this.db.getGroupsForDevice(nodeId);
    const allGroupIds = new Set<number>(existingGroups.map((g) => g.groupId));
    allGroupIds.add(groupId);

    const groupKeyMapValue = [...allGroupIds].map((gid) => ({
      groupId:       gid,
      groupKeySetId: gid,           // groupKeySetId === groupId (our design)
      fabricIndex:   FabricIndex(0), // 0 = current fabric
    }));

    WriteResult.assertSuccess(
      await (peer as any).interaction.write(
        Write(Write.Attribute({
          endpoint:   EndpointNumber(0),
          cluster:    GroupKeyManagementBehavior.cluster,
          attributes: ["groupKeyMap"],
          value:      groupKeyMapValue,
        }))
      )
    );
    console.log(
      `[Groups] GroupKeyMap write → ${nodeId} ` +
      `entries=[${[...allGroupIds].join(",")}]`
    );
  }

  // ── Per-device Groups cluster commands ────────────────────────────────────

  /**
   * addDeviceToGroup()
   *
   * Full provisioning sequence before AddGroup:
   *   1. KeySetWrite to device ep0
   *   2. GroupKeyMap attribute write to device ep0
   *   3. AddGroup to device ep1 (Groups cluster)
   *
   * The epoch key for the group comes from the groups table in the DB
   * (set when the group was created via createGroup()).
   *
   * STATUS_DUPLICATE_EXISTS (0x8A) is treated as success — the device is
   * already a member, which is the desired end-state.
   */
  async addDeviceToGroup(
    nodeId:      string,
    groupId:     number,
    groupName:   string,
    epochKeyHex: string,
  ): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);

    // Provision the group key on the device BEFORE calling AddGroup.
    // If epochKeyHex is empty (group created before GroupKeyManagement support),
    // generate a fresh key and backfill the DB row so later AddGroup calls
    // for other devices in the same group reuse the same key.
    let epochKey: Buffer;
    if (!epochKeyHex || epochKeyHex.length !== 32) {
      epochKey = randomBytes(16);
      const newHex = epochKey.toString("hex");
      this.db.updateGroupEpochKey(groupId, newHex);
      await this.provisionControllerGroupKey(groupId, groupId, epochKey);
      console.log(`[Groups] Generated epoch key for pre-existing group ${groupId}`);
    } else {
      epochKey = Buffer.from(epochKeyHex, "hex");
    }
    await this.provisionDeviceGroupKey(nodeId, groupId, groupId, epochKey);

    const response = await ep.commandsOf(GroupsClient).addGroup({
      groupId:   GroupId(groupId),
      groupName,
    });

    const status = Number(response.status);
    if (status !== STATUS_SUCCESS && status !== STATUS_DUPLICATE_EXISTS) {
      throw new Error(
        `AddGroup rejected by ${nodeId}: status=0x${status.toString(16)}`
      );
    }

    console.log(
      `[Groups] AddGroup → ${nodeId} groupId=${groupId} name="${groupName}"` +
      (status === STATUS_DUPLICATE_EXISTS ? " (already a member — ok)" : "")
    );
  }

  /**
   * removeDeviceFromGroup()
   *
   * Sends RemoveGroup to the device's Groups cluster.
   * STATUS_NOT_FOUND (0x8B) is treated as success — device is not a member,
   * which is the desired end-state.
   */
  async removeDeviceFromGroup(nodeId: string, groupId: number): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);

    const response = await ep.commandsOf(GroupsClient).removeGroup({
      groupId: GroupId(groupId),
    });

    const status = Number(response.status);
    if (status !== STATUS_SUCCESS && status !== STATUS_NOT_FOUND) {
      throw new Error(
        `RemoveGroup rejected by ${nodeId}: status=0x${status.toString(16)}`
      );
    }

    console.log(`[Groups] RemoveGroup → ${nodeId} groupId=${groupId}`);
  }

  /**
   * removeAllGroupsFromDevice()
   *
   * Sends RemoveAllGroups to the device — clears all fabric-scoped group
   * memberships. Used when decommissioning a device from all groups.
   */
  async removeAllGroupsFromDevice(nodeId: string): Promise<void> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);
    await ep.commandsOf(GroupsClient).removeAllGroups();
    console.log(`[Groups] RemoveAllGroups → ${nodeId}`);
  }

  /**
   * getDeviceGroupMembership()
   *
   * Reads the device's own group membership list directly (network call).
   * Passing an empty groupList means "return all groups".
   * Useful for verifying that AddGroup/RemoveGroup reached the device.
   */
  async getDeviceGroupMembership(nodeId: string): Promise<{
    capacity: number | null;
    groupIds: number[];
  }> {
    const ep = this.getPrimaryEndpoint(nodeId);
    if (!ep) throw new Error(`Device ${nodeId} not found in fabric.`);

    const response = await ep.commandsOf(GroupsClient).getGroupMembership({
      groupList: [] as any,   // empty = return all groups
    });

    return {
      capacity: response.capacity != null ? Number(response.capacity) : null,
      groupIds: (response.groupList ?? []).map(Number),
    };
  }

  // ── Group fan-out commands ─────────────────────────────────────────────────
  // Each method looks up DB-tracked members and sends unicast in parallel.
  // Promise.allSettled ensures a single offline device never blocks the others.
  // The response lists which devices succeeded and which failed.

  async groupOn(groupId: number): Promise<FanOutResult> {
    return this.fanOut(groupId, (id) => deviceManager.turnOn(id));
  }

  async groupOff(groupId: number): Promise<FanOutResult> {
    return this.fanOut(groupId, (id) => deviceManager.turnOff(id));
  }

  async groupToggle(groupId: number): Promise<FanOutResult> {
    return this.fanOut(groupId, (id) => deviceManager.toggle(id));
  }

  async groupSetLevel(
    groupId:        number,
    level:          number,
    transitionTime: number = 0,
  ): Promise<FanOutResult> {
    return this.fanOut(groupId, (id) =>
      deviceManager.setLevel(id, level, transitionTime)
    );
  }

  async groupSetColorTemperature(
    groupId:        number,
    mireds:         number,
    transitionTime: number = 10,
  ): Promise<FanOutResult> {
    return this.fanOut(groupId, (id) =>
      deviceManager.setColorTemperature(id, mireds, transitionTime)
    );
  }

  // ── Private fan-out helper ─────────────────────────────────────────────────

  private async fanOut(
    groupId: number,
    fn:      (nodeId: string) => Promise<void>,
  ): Promise<FanOutResult> {
    const members = this.db.getGroupMembers(groupId);
    if (members.length === 0) return { succeeded: [], failed: [] };

    const results = await Promise.allSettled(members.map((id) => fn(id)));

    const succeeded: string[] = [];
    const failed:    string[] = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        succeeded.push(members[i]);
      } else {
        failed.push(members[i]);
        console.warn(
          `[Groups] Fan-out failed for ${members[i]} in group ${groupId}:`,
          (result as PromiseRejectedResult).reason
        );
      }
    });

    console.log(
      `[Groups] Fan-out group=${groupId} ` +
      `ok=[${succeeded.join(", ")}]` +
      (failed.length ? ` FAILED=[${failed.join(", ")}]` : "")
    );

    return { succeeded, failed };
  }
}
