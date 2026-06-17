#!/bin/bash
# Sync Filmaffinity lists to Stremio addon server
# Run from Termux (Android) to bypass Cloudflare blocking

# === CONFIGURATION ===
SERVER="https://addon-stremio-filmaffinity.onrender.com"
USER_ID="3732565"
LISTS="1001 1002"
# =====================

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
HTMLFILE=$(mktemp)
JSONFILE=$(mktemp)

for LIST_ID in $LISTS; do
  echo "Syncing list $LIST_ID..."

  curl -s -L \
    -H "User-Agent: $UA" \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: es-ES,es;q=0.9" \
    -o "$HTMLFILE" \
    "https://www.filmaffinity.com/es/userlist.php?user_id=$USER_ID&list_id=$LIST_ID"

  if grep -q "data-movie-id" "$HTMLFILE"; then
    jq -n --arg u "$USER_ID" --arg l "$LIST_ID" --rawfile h "$HTMLFILE" \
      '{userId: $u, listId: $l, html: $h}' > "$JSONFILE"
    RESPONSE=$(curl -s -X POST "$SERVER/api/sync" \
      -H "Content-Type: application/json" \
      -d @"$JSONFILE")
    echo "  $RESPONSE"
  else
    echo "  Error: Cloudflare blocked the request or list is empty"
    echo "  Try opening filmaffinity.com in your phone browser first, then retry"
  fi
done

rm -f "$HTMLFILE" "$JSONFILE"
echo "Done!"
