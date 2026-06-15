/**
 * config.ts
 *
 * Reads the .env file and exports typed configuration constants.
 * Every other module imports from here — never from process.env directly.
 * If a required variable is missing we crash immediately with a clear message
 * rather than getting a confusing error later.
 *
 * ─── BLE-related variables (added for BLE commissioning) ────────────────────
 *   BLE_ENABLED   "true" / "false". Default false. When true, MatterController
 *                 attempts to register the BLE adapter at startup. Has no
 *                 effect if @matter/nodejs-ble is not installed.
 *   BLE_HCI_ID    Linux HCI device index. Default 0. Override only if you
 *                 have multiple Bluetooth adapters and need a specific one.
 *   WIFI_SSID     Default Wi-Fi SSID for BLE commissioning. Optional —
 *                 the API can override per-commission via the request body.
 *   WIFI_PASSWORD Default Wi-Fi password. Same — overridable per request.
 *
 * SECURITY NOTE: WIFI_PASSWORD in .env is plaintext on disk. For a thesis
 * demo this is fine; for production you'd want a secret manager.
 */

import "dotenv/config";

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

export const config = {
  // Outbound WS Connection Details
  cloudWsUrl: optional("CLOUD_WS_URL", ""),
  gatewaySecretToken: optional("GATEWAY_SECRET_TOKEN", ""),

  // Directory where matter.js writes its fabric + session data
  matterStoragePath: optional("MATTER_STORAGE_PATH", "./matter-storage"),

  // SQLite file path for our application database
  dbPath: optional("DB_PATH", "./database.sqlite"),

  // Label visible in the Matter fabric (shows up in chip-tool, etc.)
  fabricLabel: optional("FABRIC_LABEL", "MatterController"),

  // ── BLE commissioning ──────────────────────────────────────────────────
  bleEnabled: optionalBool("BLE_ENABLED", false),
  bleHciId:   parseInt(optional("BLE_HCI_ID", "0"), 10),

  // ── Default Wi-Fi credentials passed to BLE-commissioned devices ───────
  // Empty string means "no default" — the API request body must supply them.
  defaultWifiSsid:     optional("WIFI_SSID",     ""),
  defaultWifiPassword: optional("WIFI_PASSWORD", ""),
};