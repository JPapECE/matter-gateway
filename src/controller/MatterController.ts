/**
 * MatterController.ts  —  matter.js 0.16.x API
 *
 * ─── What changed from older versions ──────────────────────────────────────
 * Old API (0.10.x and earlier, now gone):
 *   MatterServer  +  CommissioningController  +  commissionWithCode()
 *
 * New API (0.16.x, what we use):
 *   ServerNode  +  ControllerBehavior  +  node.peers.commission()
 *
 * ─── Mental model ───────────────────────────────────────────────────────────
 * Think of ServerNode as YOUR controller's own identity on the Matter fabric.
 * By default a ServerNode is a device (it serves clusters to others).
 * Adding ControllerBehavior flips it into a controller — now it can discover,
 * commission, and command OTHER devices instead of just answering to them.
 *
 * ─── Storage ────────────────────────────────────────────────────────────────
 * NodeJsEnvironment() is a factory function (not a class constructor).
 * It returns an Environment object pre-wired with Node.js crypto, UDP
 * networking, and mDNS. We tell it WHERE to store the fabric keys by setting
 * "storage.path" on the environment's vars map BEFORE passing it to ServerNode.
 * matter.js will create a subdirectory per node-id inside that path.
 *
 * ─── Startup sequence ───────────────────────────────────────────────────────
 * 1. NodeJsEnvironment()          — configure platform adapters + storage path
 * 2. registerBleAdapter()         — IF BLE_ENABLED, register Ble.get factory
 *                                   (must happen BEFORE ServerNode.create)
 * 3. ServerNode.create(...)       — build the node identity (reads stored keys)
 * 4. node.run()                   — open UDP sockets, start mDNS (don't await)
 * 5. await node.lifecycle.online  — suspends until sockets are truly bound
 *
 * node.lifecycle.online is an Observable that also acts as a Promise, so
 * awaiting it is safe and will resolve as soon as the node reports "is online".
 *
 * ─── Singleton ──────────────────────────────────────────────────────────────
 * We export one shared instance so CommissioningService and DeviceManager
 * always reference the same running node.
 */

import { ControllerBehavior, ServerNode } from "@matter/main";
import { NodeJsEnvironment } from "@matter/nodejs";
import fs from "fs";
import { config } from "../config.js";
import { registerBleAdapter } from "./BleService.js";

class MatterController {
  // Public so CommissioningService and DeviceManager can reach node.peers
  public node!: ServerNode;
  private running    = false;
  private bleEnabled = false;

  /**
   * bleSupported — whether the controller was successfully started with
   * BLE support. CommissioningService consults this before attempting a
   * BLE commissioning so it can return a clean 503 instead of crashing
   * deep inside matter.js.
   */
  public bleSupported(): boolean {
    return this.bleEnabled;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Ensure the storage directory exists before matter.js tries to open it
    if (!fs.existsSync(config.matterStoragePath)) {
      fs.mkdirSync(config.matterStoragePath, { recursive: true });
    }

    // ── 1. Environment ────────────────────────────────────────────────────
    // NodeJsEnvironment() wires up:
    //   - Node.js crypto  (ECDH, AES-CCM, HKDF, ECDSA)
    //   - NodeJsNetwork   (UDP unicast + multicast, mDNS on port 5353)
    //   - StorageFactory  (reads/writes JSON files under storage.path)
    const env = NodeJsEnvironment();

    // Tell the storage factory where to put its files.
    // matter.js appends the node's id as a subdirectory, so the actual
    // fabric data will be at  <matterStoragePath>/<fabricLabel>/
    env.vars.set("storage.path", config.matterStoragePath);

    // ── 2. BLE adapter registration ───────────────────────────────────────
    // Must run BEFORE ServerNode.create(). The function imports
    // @matter/nodejs-ble (which registers a ServiceBundle as a side effect),
    // then sets env.vars "ble.enable" = true and "ble.hci.id" = N.
    // The ServiceBundle reacts to those vars and wires up NodeJsBle as the
    // Ble service in the environment. Returns false if BLE_ENABLED is off
    // or the package failed to load — in that case we proceed without BLE.
    this.bleEnabled = await registerBleAdapter(env);

    // ── 3. ServerNode ─────────────────────────────────────────────────────
    // ServerNode.RootEndpoint.with(ControllerBehavior) produces a new
    // endpoint definition that includes all the standard Root clusters
    // PLUS the controller behavior that lets us commission other nodes.
    //
    // The `id` field is the node's storage namespace key — it must be stable
    // across restarts so the node finds its saved fabric keys.
    //
    // ── Why network.ble=false AND controller.ble=true? ──────────────────
    // Two separate BLE roles exist in matter.js:
    //
    //   network.ble=true  (default when Ble is in env)
    //     → ServerNetworkRuntime.addTransports() registers Ble.peripheralInterface
    //       (BlenoPeripheralInterface) in ConnectionlessTransportSet. This makes
    //       the controller itself advertisable/commissionable over BLE as a device.
    //       We do NOT want this — we are a pure controller.
    //
    //   controller.ble=true
    //     → ControllerBehavior.initialize() adds Ble.scanner to ScannerSet.
    //     → ControllerBehavior.#nodeOnline() registers Ble.centralInterface
    //       (NobleBleCentralInterface) in ConnectionlessTransportSet.
    //       This is what allows the controller to COMMISSION OTHER devices over BLE.
    //       We DO want this.
    //
    // The bug: ConnectionlessTransportSet.interfaceFor() uses find() — first match
    // wins. Both interfaces claim ChannelType.BLE. addTransports() runs BEFORE
    // #nodeOnline(), so if network.ble=true, the peripheral interface is inserted
    // first. When PASE over BLE is attempted, the peripheral interface is selected
    // → throws "Outbound connections are not supported on peripheral interfaces".
    //
    // Fix: network.ble=false skips peripheral registration entirely.
    //      controller.ble=this.bleEnabled still registers the central interface.
    this.node = await ServerNode.create(
        ServerNode.RootEndpoint.with(ControllerBehavior),
        {
            environment: env,
            id: config.fabricLabel,
            network: {
                ble: false,           // prevent peripheral (Bleno) interface from registering
            },
            controller: {
                ble: this.bleEnabled, // register central (Noble) interface + BLE scanner
                ip: true,
            },
        }
    );

    // ── 4. Run ────────────────────────────────────────────────────────────
    // node.run() opens the UDP sockets and starts the mDNS announcer.
    // We do NOT await it — it is a long-running promise that only resolves
    // when the node shuts down. Awaiting it here would block forever.
    this.node.run().catch((err: Error) => {
      console.error("[Matter] Fatal runtime error:", err);
    });

    // ── 5. Wait for online ────────────────────────────────────────────────
    // lifecycle.online is an Observable<void> that also implements .then(),
    // so we can await it like a Promise. It resolves once the node has
    // bound its UDP sockets and is ready to communicate on the network.
    await this.node.lifecycle.online;

    this.running = true;
    console.log(`[Matter] Controller online. Fabric: "${config.fabricLabel}"`);
    console.log(`[Matter] Storage: ${config.matterStoragePath}`);
    console.log(`[Matter] BLE:     ${this.bleEnabled ? "enabled" : "disabled"}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // node.close() sends session-closure messages to all connected peers,
    // flushes storage, and releases the UDP sockets cleanly.
    // The BLE adapter (if any) is closed implicitly when the process exits.
    await this.node.close();
    this.running = false;
    console.log("[Matter] Controller stopped.");
  }

  isRunning(): boolean {
    return this.running;
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────
export const matterController = new MatterController();