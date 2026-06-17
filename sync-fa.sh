#!/bin/bash
# Sync Filmaffinity lists to Stremio addon server
# Run from Termux (Android) to bypass Cloudflare blocking

# === CONFIGURATION ===
SERVER="https://addon-stremio-filmaffinity.onrender.com"
USER_ID="3732565"
LISTS="1001 1002"
# =====================

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
PAGEFILE=$(mktemp)
ALLHTML=$(mktemp)

for LIST_ID in $LISTS; do
  echo "Syncing list $LIST_ID..."
  > "$ALLHTML"
  PAGE=1
  FOUND_ITEMS=0

  while true; do
    URL="https://www.filmaffinity.com/es/userlist.php?user_id=$USER_ID&list_id=$LIST_ID"
    if [ $PAGE -gt 1 ]; then
      URL="${URL}&p=$PAGE"
    fi

    curl -s -L \
      -H "User-Agent: $UA" \
      -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
      -H "Accept-Language: es-ES,es;q=0.9" \
      -o "$PAGEFILE" \
      "$URL"

    if ! grep -q "data-movie-id" "$PAGEFILE"; then
      if [ $PAGE -eq 1 ]; then
        echo "  Error: Cloudflare blocked the request or list is empty"
      fi
      break
    fi

    ITEMS=$(grep -o "data-movie-id" "$PAGEFILE" | wc -l)
    FOUND_ITEMS=$((FOUND_ITEMS + ITEMS))
    echo "  Page $PAGE: $ITEMS items"
    cat "$PAGEFILE" >> "$ALLHTML"

    if grep -q "Siguiente" "$PAGEFILE" || grep -q "pag-next" "$PAGEFILE"; then
      PAGE=$((PAGE + 1))
      sleep 1
    else
      break
    fi
  done

  if [ $FOUND_ITEMS -gt 0 ]; then
    echo "  Sending $FOUND_ITEMS items to server..."
    RESPONSE=$(curl -s -X POST \
      "$SERVER/api/sync?userId=$USER_ID&listId=$LIST_ID" \
      -H "Content-Type: text/html" \
      --data-binary @"$ALLHTML")
    echo "  $RESPONSE"
  fi
done

rm -f "$PAGEFILE" "$ALLHTML"
echo "Done!"
