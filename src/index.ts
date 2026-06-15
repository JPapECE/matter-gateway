/**
 * index.ts
 * Entry point for matter-gateway.
 */

import { DatabaseService }      from "./database/DatabaseService.js";
import { matterController }     from "./controller/MatterController.js";
import { deviceManager }        from "./controller/DeviceManager.js";
import { CommissioningService } from "./controller/CommissioningService.js";
import { GroupsManager }        from "./controller/GroupsManager.js";
import { gatewayBridge }        from "./bridge/GatewayBridge.js";
import { eventForwarder }       from "./bridge/EventForwarder.js";

const ENERGY_RECORD_INTERVAL_MS = 30_000;
const ENERGY_RECORD_INITIAL_DELAY_MS = 10_000;

async function main(): Promise<void> {
  console.log("─────────────────────────────────────────");
  console.log("  Matter Gateway — starting up");
  console.log("─────────────────────────────────────────");

  // 1. Database
  const db = new DatabaseService();

  // Initialize event forwarder
  eventForwarder.init(db);

  // 2. Matter stack
  await matterController.start();

  // 3. Reconnect known devices
  const storedDevices = db.getAllDevices();
  if (storedDevices.length > 0) {
    console.log(`[Boot] Reconnecting ${storedDevices.length} known device(s)...`);
    await deviceManager.logKnownPeers(storedDevices.map((d) => d.nodeId));
  } else {
    console.log("[Boot] No devices stored yet. Commission your first device.");
  }

  // 4. Services
  const commissioningService = new CommissioningService(db);
  const groupsManager        = new GroupsManager(db);

  // 5. Gateway Bridge (WebSocket connection to cloud)
  gatewayBridge.init(db, commissioningService, groupsManager);

  console.log("─────────────────────────────────────────");
  console.log("  Gateway Services Ready.");
  console.log("─────────────────────────────────────────");

  // 6. Energy recording loop
  async function recordEnergyReadings(): Promise<void> {
    const devices = db.getAllDevices();

    for (const device of devices) {
      try {
        const [power, energy] = await Promise.all([
          deviceManager.getPower(device.nodeId),
          deviceManager.getEnergy(device.nodeId),
        ]);

        // Skip if the device is offline or doesn't support energy clusters (all values null)
        if (
          power.activePower      === null &&
          power.voltage          === null &&
          energy.cumulativeEnergy === null
        ) {
          continue;
        }

        // Broadcast/Forward the telemetry snapshot.
        // EventForwarder handles saving it to SQLite and pushing it to the cloud.
        deviceManager.broadcast({
          event: "energy_snapshot",
          nodeId: device.nodeId,
          power,
          energy,
        });

        console.log(
          `[Energy] Broadcast for ${device.nodeId}: ` +
          `power=${power.activePower?.toFixed(1) ?? "n/a"}W ` +
          `cumulative=${energy.cumulativeEnergy?.toFixed(3) ?? "n/a"}Wh`
        );
      } catch (err: any) {
        console.warn(`[Energy] Failed to poll reading for ${device.nodeId}:`, err.message);
      }
    }
  }

  // Wait for devices to settle before starting the polling loop
  setTimeout(() => {
    recordEnergyReadings().catch(err =>
      console.error("[Energy] Initial poll error:", err)
    );

    setInterval(() => {
      recordEnergyReadings().catch(err =>
        console.error("[Energy] Polling error:", err)
      );
    }, ENERGY_RECORD_INTERVAL_MS);

    console.log(
      `[Energy] Polling loop started — every ${ENERGY_RECORD_INTERVAL_MS / 1000}s`
    );
  }, ENERGY_RECORD_INITIAL_DELAY_MS);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}...`);
    eventForwarder.shutdown();
    await matterController.stop();
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
