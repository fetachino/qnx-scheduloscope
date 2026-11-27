#!/usr/bin/env bash
# Boot the standalone QNX x86_64 disk repeatedly and summarize the JSON reports.
# Intended for a Linux/WSL host with QEMU and Python 3; it does not build the disk.
set -u

DISK=".tmp/qnx-native-final/disk-test"
OUT=".tmp/qnx-stress"
ACCEL="kvm"
CPU="host"
RUNS="3"
TIMEOUT="55"

usage() {
  cat <<'EOF'
Usage: scripts/qnx-stress.sh [options]
  --disk PATH      QNX disk image (default .tmp/qnx-native-final/disk-test)
  --out DIR        output directory (default .tmp/qnx-stress)
  --accel kvm|tcg  QEMU accelerator (default kvm)
  --cpu MODEL      QEMU CPU model (default host for kvm, max for tcg)
  --runs N         number of boots (default 3)
  --timeout SEC    wall-clock cap per boot (default 55)
  --help           show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --disk) DISK="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --accel) ACCEL="$2"; shift 2 ;;
    --cpu) CPU="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$ACCEL" = "tcg" ] && [ "$CPU" = "host" ]; then CPU="max"; fi
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  echo "qemu-system-x86_64 not found" >&2; exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found" >&2; exit 2
fi
if [ ! -f "$DISK" ]; then
  echo "disk image not found: $DISK" >&2; exit 2
fi
if [ "$ACCEL" = "kvm" ] && [ ! -e /dev/kvm ]; then
  echo "/dev/kvm is missing; rerun with --accel tcg --cpu max" >&2; exit 2
fi

mkdir -p "$OUT"
rm -f "$OUT/rows.jsonl"

for i in $(seq 1 "$RUNS"); do
  log="$OUT/${ACCEL}-${i}.log"
  start=$(date +%s)
  timeout "${TIMEOUT}s" qemu-system-x86_64 -accel "$ACCEL" -cpu "$CPU" -m 512M -smp 1 \
    -nographic -boot c -drive "file=$DISK,format=raw,if=ide" -no-reboot >"$log" 2>&1
  code=$?
  elapsed=$(( $(date +%s) - start ))
  python3 - "$log" "$i" "$ACCEL" "$CPU" "$code" "$elapsed" >> "$OUT/rows.jsonl" <<'PY'
import json, sys
log, run, accel, cpu, code, elapsed = sys.argv[1:]
text = open(log, encoding="utf-8", errors="replace").read()
obj = None
decoder = json.JSONDecoder()
pos = text.find("{")
while pos != -1:
    try:
        obj, _ = decoder.raw_decode(text[pos:])
        break
    except json.JSONDecodeError:
        pos = text.find("{", pos + 1)
row = {"run": int(run), "accel": accel, "cpu": cpu, "qemu_exit": int(code), "wall_seconds": int(elapsed), "log": log}
if obj is None:
    row.update({"ok": False, "error": "no JSON report in boot log"})
else:
    tasks = obj.get("tasks", [])
    row.update({
        "ok": obj.get("platform") == "qnx" and obj.get("scheduling") == "enforced" and obj.get("duration_us", 0) >= 29_000_000 and len(tasks) > 0,
        "platform": obj.get("platform"), "scheduling": obj.get("scheduling"),
        "duration_us": obj.get("duration_us"), "tasks": len(tasks),
        "deadline_misses": sum(int(t.get("deadline_misses", 0)) for t in tasks),
        "max_response_us": max([int(t.get("max_us", 0)) for t in tasks] or [0]),
        "max_activation_latency_us": max([int(t.get("max_activation_latency_us", 0)) for t in tasks] or [0]),
    })
print(json.dumps(row))
PY
  echo "run $i/$RUNS: accel=$ACCEL cpu=$CPU qemu_exit=$code wall=${elapsed}s"
done

python3 - "$OUT/rows.jsonl" "$OUT/summary.json" <<'PY'
import datetime, json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
summary = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "accel": rows[0]["accel"] if rows else None,
    "cpu": rows[0]["cpu"] if rows else None,
    "runs": len(rows),
    "ok": bool(rows) and all(row.get("ok") for row in rows),
    "results": rows,
}
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(summary, indent=2) + "\n")
print(json.dumps({k: summary[k] for k in ("accel", "cpu", "runs", "ok")}, indent=2))
PY

python3 - "$OUT/summary.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
sys.exit(0 if s["ok"] else 1)
PY
