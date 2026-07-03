# Verifo Node Client

Real contributor node client. Detects your machine's actual CPU/RAM/GPU, generates a
local identity keypair, and proves your node is online via signed heartbeats — no
simulated data.

## Requirements

- Node.js 18 or newer installed on your machine.

## Setup

1. On your Verifo contributor dashboard, click "Download Node Software" and copy the
   pairing code shown.
2. In this folder, run:

   ```
   npm install
   node bin/verifo-node.mjs link <PAIRING_CODE>
   ```

3. Start reporting:

   ```
   node bin/verifo-node.mjs start
   ```

Leave it running — it sends a signed heartbeat every 30 seconds. Your dashboard will
show "online" only while this process is running on your machine.
