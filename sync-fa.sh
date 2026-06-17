#!/bin/bash
# Sync Filmaffinity lists to Stremio addon server
# Run from Termux (Android) to bypass Cloudflare blocking

# === CONFIGURATION ===
SERVER="https://addon-stremio-filmaffinity.onrender.com"
USER_ID="3732565"
LISTS="1001 1002"
# =====================

for LIST_ID in $LISTS; do
  echo "Syncing list $LIST_ID..."

  HTML=$(curl -s -L "https://www.filmaffinity.com/es/userlist.php?user_id=$USER_ID&list_id=$LIST_ID")

  if [ -z "$HTML" ]; then
    echo "  Error: could not fetch list $LIST_ID"
    continue
  fi

  RESPONSE=$(curl -s -X POST "$SERVER/api/sync" \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"$USER_ID\",\"listId\":\"$LIST_ID\",\"html\":$(echo "$HTML" | jq -Rs .)}")

  echo "  $RESPONSE"
done

echo "Done!"
