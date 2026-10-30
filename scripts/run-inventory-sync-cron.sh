#!/bin/bash
# Invoked every 30 minutes by the com.customblvd.sanmar-inventory-sync
# LaunchAgent (~/Library/LaunchAgents/) to keep Shopify inventory synced
# with SanMar's live stock feed. Sources nvm so it finds `node` under
# launchd's minimal PATH, same as any interactive shell would.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/.." || exit 1
node src/inventory-sync.js >> logs/inventory-sync.log 2>&1
