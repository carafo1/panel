#!/bin/bash
# Start realtime service and keep it alive
cd "$(dirname "$0")"
exec bun index.ts
