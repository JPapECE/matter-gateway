# Matter Gateway

The gateway component of the distributed, split-architecture Matter Controller. Designed to run on local hardware (e.g., Raspberry Pi) within the home network.

It runs **matter.js** to manage local smart home devices over IP and Bluetooth Low Energy (BLE), maintaining a persistent outbound-only WebSocket connection to the hosted cloud server (`matter-cloud`).

---

## Key Features

- **Outbound-Only WebSocket Bridge**: Traverses NAT boundaries and firewalls cleanly. Initiates an outbound TLS connection (`wss://`) to the cloud; no port-forwarding or local reverse proxy needed.
- **Local Groups Source of Truth**: Evaluates groups and memberships locally via `GroupsManager` to conduct fabric-scoped security key-set writes (`KeySetWrite`) and CASE session establishment directly on local devices.
- **SQLite Telemetry Buffer**: Caches device states and periodic energy telemetry in a local database buffer when offline, and automatically flushes them in-order once the cloud connection is restored.
- **BLE Commissioning Support**: Commissions factory-reset devices over Bluetooth Low Energy using raw sockets and host network capabilities. Redacts Wi-Fi credentials from all memory/logs to ensure credential safety.

---

## Directory Structure

```
matter-gateway/
├── src/
│   ├── bridge/
│   │   ├── GatewayBridge.ts       # Handles WebSocket client, auth, heartbeats & reconnects
│   │   ├── CommandHandler.ts      # Routes 24 protocol commands (devices & groups)
│   │   └── EventForwarder.ts      # Buffers/forwards state changes and energy telemetry
│   ├── controller/
│   │   ├── MatterController.ts    # Initializes the matter.js ServerNode
│   │   ├── DeviceManager.ts       # Operates Matter plug units (On/Off, Level, Energy)
│   │   ├── CommissioningService.ts # Pairings (IP & BLE)
│   │   └── GroupsManager.ts       # Custom fabric key exchange and fan-out unicast
│   ├── database/
│   │   └── DatabaseService.ts     # Lightweight SQLite schema (device_cache, energy_buffer)
│   ├── types/
│   │   └── gateway-protocol.ts    # Discriminated union types for WSS message contracts
│   ├── config.ts                  # Typed environment variable registry
│   └── index.ts                   # Bootstrapping and energy polling loop
├── Dockerfile                     # Multi-stage production build
└── tsconfig.json                  # Target: ES2022, NodeNext resolution
```

---

## Environment Variables

A `.env` file must be created at the root of the project with the following configuration:

```env
# Outbound Connection Configuration
CLOUD_WS_URL=wss://your-cloud-api-domain.com/gateway
GATEWAY_SECRET_TOKEN=your_64_character_hexadecimal_secret_token

# BLE commissioning configuration
BLE_ENABLED=true
BLE_HCI_ID=0

# Storage Locations
DB_PATH=./database.sqlite
MATTER_STORAGE_PATH=./matter-storage
```

---

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run in development mode (watcher)**:
   ```bash
   npm run dev
   ```

3. **Build the production bundle**:
   ```bash
   npm run build
   ```

4. **Start the production server**:
   ```bash
   npm run start
   ```

---

## Docker Deployment

To allow mDNS (multicast DNS) discovery and Bluetooth scanning to operate correctly, the Docker container must run with host-level networking and system capabilities:

```bash
docker build -t matter-gateway .

docker run -d \
  --name matter-gateway \
  --network host \
  --cap-add=NET_RAW \
  --cap-add=NET_ADMIN \
  -v matter-storage:/app/matter-storage \
  -v sqlite:/app/database.sqlite \
  -e CLOUD_WS_URL=wss://your-cloud-api-domain.com/gateway \
  -e GATEWAY_SECRET_TOKEN=your_token_here \
  matter-gateway
```

### Volume Mounts
- `/app/matter-storage`: Persists Matter security keys, fabric certificates, and session configurations.
- `/app/database.sqlite`: Holds local SQLite database containing device metadata and group mappings.
