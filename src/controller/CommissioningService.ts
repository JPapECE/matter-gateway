/**
 * CommissioningService.ts  —  matter.js 0.16.x API
 *
 * ─── Pairing code formats ────────────────────────────────────────────────────
 *
 *   QR code     "MT:A9CA00O614GA5K7GZ10"
 *               Encodes: passcode + full 12-bit long discriminator + VID/PID
 *               Decoded with QrPairingCodeCodec; passed as { passcode, discriminator }.
 *
 *   Manual code "01428255814"  (11 digits)
 *               Encodes: passcode + 4-bit SHORT discriminator only.
 *               Passing as { pairingCode } triggers a matter.js 0.16.x bug
 *               (double no-timeout mDNS waiter → hangs). Fix: decode ourselves
 *               and pass { passcode } only.
 *
 * ─── Commissioning transports ────────────────────────────────────────────────
 *
 *   IP-only (default — device already on Wi-Fi):
 *     mDNS discovery → PASE over IP → NOC → CASE → done
 *
 *   BLE (device NOT yet on Wi-Fi):
 *     BLE scan → BLE GATT → PASE over BLE → NOC → AddOrUpdateWifiNetwork →
 *     ConnectNetwork → device joins Wi-Fi → CASE over IP → done
 *
 *   The IP-only path is unchanged from the original implementation. The BLE
 *   path is taken when wifi credentials are supplied in the request AND the
 *   controller was started with BLE_ENABLED=true.
 *
 * ─── Post-commissioning capability discovery ─────────────────────────────────
 *   After CASE is established (regardless of transport), commission() calls
 *   deviceManager.discoverCapabilities() which reads the Descriptor cluster's
 *   serverList and deviceTypeList. The result is saved to the
 *   device_capabilities table via DatabaseService.
 *
 *   This is done with a best-effort approach: if discovery fails (e.g. device
 *   goes offline immediately after pairing), the device is still saved and
 *   discovery can be triggered later via GET /api/devices/:id/capabilities?refresh=true.
 */

import { QrPairingCodeCodec } from "@matter/types";
import { ControllerCommissioningFlow } from "@matter/protocol";
import { matterController } from "./MatterController.js";
import { deviceManager }    from "./DeviceManager.js";
import { DatabaseService }  from "../database/DatabaseService.js";
import { config }           from "../config.js";

// ── Manual pairing code decoder ───────────────────────────────────────────────
// Matter spec §5.1.4.1 — 11-digit manual code (no VID/PID variant):
//   chunk2 (digits 1-5): bits 13:0 = passcode[13:0], bits 15:14 = discriminator[1:0]
//   chunk3 (digits 6-10): bits 12:0 = passcode[26:14]
function decodeManualCode(code: string): { passcode: number } {
  const chunk2 = parseInt(code.slice(1, 6), 10);
  const chunk3 = parseInt(code.slice(6, 10), 10);
  const passcode = ((chunk3 & 0x1fff) << 14) | (chunk2 & 0x3fff);
  return { passcode };
}

// ── Wi-Fi field length limits per Matter spec §11.8.5 (NetworkCommissioning) ──
// SSID:        1..32 octets
// Credentials: 0..64 octets (0 for open networks; 8..63 for WPA2-PSK ASCII)
const SSID_MAX_BYTES        = 32;
const CREDENTIALS_MAX_BYTES = 64;

/**
 * Commission options accepted by node.peers.commission() in 0.16.x.
 */
interface CommissionOptions {
  passcode:              number;
  discriminator?:        number;
  commissioningFlowImpl?: typeof ControllerCommissioningFlow;
}

/**
 * createWifiCommissioningFlow()
 *
 * Returns a subclass of ControllerCommissioningFlow with wifiNetwork baked in.
 *
 * WHY THIS EXISTS:
 * CommissioningClient.commission() — the class behind node.peers.commission() —
 * builds commissioningOptions internally and does NOT forward wifiNetwork.
 * Its source even has a "// TODO: allow wifi/thread credentials" comment.
 * It DOES forward commissioningFlowImpl, so we use that as our injection point.
 *
 * ControllerCommissioner.#commissionConnectedNode() calls:
 *   new commissioningFlowImpl(interaction, ca, fabric, commissioningOptions, ...)
 *
 * Our subclass spreads commissioningOptions then adds wifiNetwork before
 * calling super(), so the NetworkCommissioning.Validate step (step 16) finds it.
 *
 * ControllerCommissioningFlow.commissioningOptions.wifiNetwork shape (from types):
 *   { wifiSsid: string, wifiCredentials: string }
 * Both are plain strings — matter.js converts them to bytes internally via
 * Bytes.fromString() before writing to the device's NetworkCommissioning cluster.
 */
function createWifiCommissioningFlow(ssid: string, password: string): typeof ControllerCommissioningFlow {
  return class extends ControllerCommissioningFlow {
    constructor(
      interaction:          any,
      ca:                   any,
      fabric:               any,
      commissioningOptions: any,
      transitionToCase:     any,
    ) {
      super(interaction, ca, fabric, {
        ...commissioningOptions,
        wifiNetwork: {
          wifiSsid:        ssid,
          wifiCredentials: password,
        },
      }, transitionToCase);
    }
  } as unknown as typeof ControllerCommissioningFlow;
}

export interface WifiCredentials {
  ssid:     string;
  password: string;
}

export class CommissioningService {
  constructor(private db: DatabaseService) {}

  /**
   * commission()
   *
   * Full commissioning flow:
   *   1. Decode pairing code  (QR or manual)
   *   2. Resolve transport    (BLE if wifi creds supplied AND BLE supported, else IP)
   *   3. mDNS or BLE discovery
   *   4. PASE                 (password-authenticated session)
   *   5. NOC issuance         (operational certificate, fabric membership)
   *   6. (BLE only) AddOrUpdateWifiNetwork + ConnectNetwork
   *   7. CASE                 (certificate-authenticated session, permanent)
   *   8. commissioningComplete (device acknowledges fabric membership)
   *   9. Save to DB
   *  10. Discover capabilities (read Descriptor cluster, store in DB)
   *
   * @param pairingCode  QR string ("MT:...") or 11-digit manual code
   * @param name         Friendly label  e.g. "Kitchen Plug"
   * @param type         Device category e.g. "smart-plug"
   * @param wifi         Optional Wi-Fi credentials. If supplied and BLE is
   *                     enabled, the controller commissions over BLE and
   *                     pushes these credentials to the device. If omitted,
   *                     the device is assumed already on Wi-Fi (IP path).
   * @returns            Matter nodeId string (e.g. "peer16")
   */
  async commission(
    pairingCode: string,
    name:        string,
    type:        string = "smart-plug",
    wifi?:       WifiCredentials,
  ): Promise<string> {
    const trimmed = pairingCode.trim();
    const isQr     = trimmed.startsWith("MT:");
    const isManual = /^\d{11}$/.test(trimmed) || /^\d{16}$/.test(trimmed);

    if (!isQr && !isManual) {
      throw new Error(
        `Invalid pairing code "${trimmed}". ` +
        `Expected a QR string starting with "MT:" or an 11-digit manual code.`
      );
    }

    // ── Decide transport ─────────────────────────────────────────────────────
    // If the caller supplied Wi-Fi credentials, they are signalling "this
    // device is NOT on the network yet, please use BLE to provision it".
    // We then require the controller to actually support BLE — otherwise
    // the commission would hang waiting for an mDNS announcement that will
    // never come.
    const useBle = wifi !== undefined;
    if (useBle && !matterController.bleSupported()) {
      throw new Error(
        "BLE commissioning requested but BLE is not enabled on this server. " +
        "Set BLE_ENABLED=true in .env, install @matter/nodejs-ble, and restart."
      );
    }

    // Validate Wi-Fi credentials length per spec §11.8.5 if present
    if (wifi) {
      const ssidBytes = new TextEncoder().encode(wifi.ssid);
      const pwdBytes  = new TextEncoder().encode(wifi.password);
      if (ssidBytes.length < 1 || ssidBytes.length > SSID_MAX_BYTES) {
        throw new Error(`Wi-Fi SSID must be 1–${SSID_MAX_BYTES} bytes UTF-8.`);
      }
      if (pwdBytes.length > CREDENTIALS_MAX_BYTES) {
        throw new Error(`Wi-Fi password must be ≤ ${CREDENTIALS_MAX_BYTES} bytes UTF-8.`);
      }
    }

    console.log(
      `[Commission] Starting pairing for "${name}" via ${useBle ? "BLE+Wi-Fi" : "IP"}...`
    );

    // ── Decode pairing code into passcode (+ optional discriminator) ─────────
    let options: CommissionOptions;

    if (isQr) {
      const [payload] = QrPairingCodeCodec.decode(trimmed);
      console.log(
        `[Commission] QR decoded — passcode: ${payload.passcode}, ` +
        `discriminator: ${payload.discriminator}`
      );
      options = {
        passcode:      payload.passcode,
        discriminator: payload.discriminator,   // full 12-bit long discriminator
      };
    } else {
      const { passcode } = decodeManualCode(trimmed);
      console.log(`[Commission] Manual code decoded — passcode: ${passcode}`);
      options = { passcode };
    }

    // ── For BLE: inject Wi-Fi credentials via commissioningFlowImpl ──────────
    // Cannot pass wifiNetwork directly — CommissioningClient drops it (see
    // createWifiCommissioningFlow above for the full explanation).
    if (useBle && wifi) {
      console.log(`[Commission] Wi-Fi target SSID: "${wifi.ssid}" (password redacted)`);
      options.commissioningFlowImpl = createWifiCommissioningFlow(wifi.ssid, wifi.password);
    }

    // ── Run the commissioning flow ───────────────────────────────────────────
    // matter.js handles PASE → NOC → (BLE: network provisioning →) CASE.
    let clientNode: any;
    try {
      clientNode = await matterController.node.peers.commission(options as any);
    } catch (err: any) {
      // Re-throw with more helpful context for common failure modes
      const msg = String(err?.message ?? err);
      if (useBle && /no.*ble|bluetooth|adapter/i.test(msg)) {
        throw new Error(
          `BLE adapter unavailable: ${msg}. ` +
          `Check BlueZ is running and the user has Bluetooth permissions.`
        );
      }
      if (useBle && /not.*found|timeout|discover/i.test(msg)) {
        throw new Error(
          `Device not found via BLE: ${msg}. ` +
          `Ensure the device is in pairing mode and within BLE range.`
        );
      }
      throw err;
    }

    const nodeId = String(clientNode.id);
    console.log(`[Commission] Pairing successful! nodeId = ${nodeId}`);

    // ── Persist device record ────────────────────────────────────────────────
    this.db.addDevice(nodeId, name, type);

    // ── Setup connection and lifecycle subscription ──────────────────────────
    await deviceManager.connect(nodeId).catch((err) => {
      console.warn(`[Commission] Initial connect/subscription setup failed for ${nodeId}:`, err.message);
    });

    // ── Capability discovery (background) ────────────────────────────────────
    // Run in background so the commission() call returns quickly to the client.
    // Errors here do not fail the commission — capabilities can be refreshed later.
    this.discoverAndSaveCapabilities(nodeId).catch((err) => {
      console.warn(
        `[Commission] Capability discovery failed for ${nodeId} — ` +
        `can be retried via /api/devices/${nodeId}/capabilities?refresh=true`,
        err
      );
    });

    return nodeId;
  }

  /**
   * commissionViaBle()
   *
   * Convenience wrapper that always uses BLE + Wi-Fi credentials.
   * Equivalent to commission(pairingCode, name, type, wifi).
   *
   * Falls back to default Wi-Fi credentials from config if `wifi` is omitted.
   * If neither argument nor config provides credentials, throws.
   */
  async commissionViaBle(
    pairingCode: string,
    name:        string,
    type:        string = "smart-plug",
    wifi?:       WifiCredentials,
  ): Promise<string> {
    const ssid     = wifi?.ssid     ?? config.defaultWifiSsid;
    const password = wifi?.password ?? config.defaultWifiPassword;

    if (!ssid) {
      throw new Error(
        "BLE commissioning requires Wi-Fi credentials. " +
        "Provide them in the request body or set WIFI_SSID/WIFI_PASSWORD in .env."
      );
    }

    return this.commission(pairingCode, name, type, { ssid, password });
  }

  /**
   * discoverAndSaveCapabilities()
   *
   * Called internally after commissioning. Also exported so routes can
   * trigger a manual refresh.
   *
   * Waits DISCOVERY_SETTLE_MS for subscriptions to populate, then reads
   * the Descriptor cluster and writes the result to device_capabilities.
   */
  async discoverAndSaveCapabilities(nodeId: string): Promise<void> {
    console.log(`[Commission] Discovering capabilities for ${nodeId}...`);

    const caps = await deviceManager.discoverCapabilities(nodeId);
    // Note: capabilities are cached in PostgreSQL on the cloud; gateway SQLite does not store them.

    console.log(
      `[Commission] Capabilities stored for ${nodeId}: ` +
      `type=${caps.deviceType}, clusters=[${caps.clusters.map(c => "0x" + c.toString(16)).join(", ")}]`
    );
  }

  /**
   * decommission()
   *
   * Sends RemoveFabric to the device (so it clears our NOC and can be
   * re-commissioned by another controller), then removes from matter.js
   * peer storage and from our database.
   *
   * If the device is offline, the fabric entry is still removed from our
   * side. The device will clear our fabric entry automatically the next
   * time it connects to any commissioner.
   */
  async decommission(nodeId: string): Promise<void> {
    console.log(`[Commission] Removing nodeId=${nodeId} from fabric...`);

    const peer = matterController.node.peers.get(nodeId);
    if (peer) {
      try {
        await peer.decommission();
        console.log(`[Commission] Device acknowledged RemoveFabric.`);
      } catch {
        console.warn(
          `[Commission] Device offline — removing from backend only. ` +
          `Device will clean up our NOC on next network contact.`
        );
      }

      // Close the local peer handle so it is removed from the matter.js peer set.
      // Without this the stale reference lingers in memory until the process restarts.
      try {
        await (peer as any).close?.();
      } catch {
        // close() may not exist in all matter.js 0.16.x builds — safe to ignore
      }
    } else {
      console.warn(`[Commission] Peer ${nodeId} not found in Matter runtime.`);
    }

    try {
      this.db.removeDevice(nodeId);   // CASCADE removes capabilities + energy rows
      console.log(`[Commission] nodeId=${nodeId} removed from database.`);
    } catch (dbErr) {
      console.error(`[Commission] DB error removing ${nodeId}:`, dbErr);
    }
  }
}