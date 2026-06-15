/**
 * BleService.ts  —  BLE adapter registration for matter.js 0.16.x
 *
 * ─── How BLE registration works in 0.16.x ───────────────────────────────────
 * In 0.16.x `Ble.get()` was REMOVED (it was the pre-0.16 pattern).
 * BLE is now registered as a service into the Environment.
 *
 * The mechanism lives entirely in @matter/nodejs-ble's install.js:
 *
 *   1. Simply *importing* "@matter/nodejs-ble" registers a ServiceBundle
 *      that watches env.vars for "ble.enable".
 *
 *   2. Calling env.vars.set("ble.enable", true) causes the ServiceBundle
 *      to instantiate a NodeJsBle and register it as the Ble service.
 *
 *   3. env.vars.set("ble.hci.id", N) selects a specific HCI adapter
 *      (Linux only, default 0 if omitted).
 *
 * So the entire registration is just two env.vars.set() calls — no
 * singleton pattern, no Ble.get replacement, nothing else needed.
 * The import itself is the side-effecting trigger.
 *
 * ─── Dynamic import — why ───────────────────────────────────────────────────
 * @matter/nodejs-ble requires native build tools (make, g++) and a working
 * BlueZ stack on Linux. By importing it dynamically we keep npm run dev
 * working in environments without Bluetooth hardware.
 *
 * ─── Correct sequence ───────────────────────────────────────────────────────
 * 1. Import @matter/nodejs-ble       → ServiceBundle is registered on env
 * 2. env.vars.set("ble.enable", true)    } before ServerNode.create()
 * 3. env.vars.set("ble.hci.id",  N)      }
 * 4. ServerNode.create({ environment: env, controller: { ble: true } })
 * 5. node.run()  / await lifecycle.online
 *
 * MatterController.ts calls registerBleAdapter(env) between steps 1 and 4.
 */

import { config } from "../config.js";

/**
 * registerBleAdapter()
 *
 * Configures the environment for BLE if BLE_ENABLED=true and
 * @matter/nodejs-ble is installed. Must be called BEFORE ServerNode.create().
 *
 * @param env  The NodeJsEnvironment instance created in MatterController.
 * @returns    true if BLE was successfully registered, false otherwise.
 */
export async function registerBleAdapter(env: any): Promise<boolean> {
  if (!config.bleEnabled) {
    console.log("[BLE] Disabled via config (BLE_ENABLED != true).");
    return false;
  }

  // ── Import @matter/nodejs-ble ─────────────────────────────────────────────
  // The import registers the ServiceBundle as a side effect via install.js.
  // Without this import, env.vars.set("ble.enable", true) is a no-op because
  // nobody is watching that var key.
  try {
    await import("@matter/nodejs-ble" as string);
  } catch (err: any) {
    console.warn(
      "[BLE] Failed to import @matter/nodejs-ble. BLE commissioning unavailable."
    );
    console.warn(
      "[BLE] To enable: npm install @matter/nodejs-ble@^0.16.11" +
      " (Linux also needs: sudo apt install build-essential libudev-dev)"
    );
    console.warn("[BLE] Error:", err?.message ?? err);
    return false;
  }

  // ── Activate BLE on the environment ──────────────────────────────────────
  // "ble.enable" = true  → NodeJsBle is instantiated and registered as Ble
  // "ble.hci.id"  = N    → selects HCI adapter (Linux only, 0 is default)
  env.vars.set("ble.enable", true);
  env.vars.set("ble.hci.id",  config.bleHciId);

  console.log(`[BLE] Registered. hciId=${config.bleHciId}`);
  console.log("[BLE] Adapter opens lazily on first commission attempt.");
  return true;
}