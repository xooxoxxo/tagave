#!/usr/bin/env bash
#
# Validate the one-click app templates in deploy/templates/:
#   - JSON (Portainer templates.json, Dokploy meta.json) parses
#   - TOML (Dokploy template.toml) parses
#   - XML (Unraid template) is well formed
#   - every compose file is accepted by `docker compose config` (with dummy
#     values for the required variables), or parses as YAML when Docker is
#     not available
#   - the Portainer stackfile exists and every variable a compose file
#     requires is offered by its platform template
#
# Needs python3 (3.11+ for tomllib). Run from anywhere: ./scripts/check-templates.sh

set -euo pipefail

cd "$(dirname "$0")/.."
T=deploy/templates

fail=0
ok()  { printf '  ok  %s\n' "$*"; }
bad() { printf '  !!  %s\n' "$*" >&2; fail=1; }

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

python3 - "$T" <<'PY' || fail=1
import json, sys, tomllib, xml.etree.ElementTree as ET, os, re
t = sys.argv[1]
failed = False
def check(label, fn):
    global failed
    try:
        fn()
        print(f"  ok  {label}")
    except Exception as e:  # noqa: BLE001
        failed = True
        print(f"  !!  {label}: {e}", file=sys.stderr)

def portainer():
    data = json.load(open(f"{t}/portainer/templates.json"))
    assert data["version"] == "3", "templates.json must be version 3"
    for tpl in data["templates"]:
        assert tpl["type"] == 3, "expected a compose stack template (type 3)"
        stack = tpl["repository"]["stackfile"]
        assert os.path.isfile(stack), f"stackfile {stack} does not exist"
        required = set(re.findall(r"\$\{([A-Z_]+):\?", open(stack).read()))
        offered = {e["name"] for e in tpl.get("env", [])}
        missing = required - offered
        assert not missing, f"required by {stack} but not asked for: {sorted(missing)}"

def dokploy():
    json.load(open(f"{t}/dokploy/meta.json"))
    toml = tomllib.load(open(f"{t}/dokploy/template.toml", "rb"))
    compose = open(f"{t}/dokploy/docker-compose.yml").read()
    required = set(re.findall(r"\$\{([A-Z_]+):\?", compose))
    offered = set(toml["config"]["env"].keys())
    missing = required - offered
    assert not missing, f"required by the compose file but not set in template.toml: {sorted(missing)}"
    services = {d["serviceName"] for d in toml["config"]["domains"]}
    for s in services:
        assert re.search(rf"^  {re.escape(s)}:\s*$", compose, re.M), f"domain service {s} not in docker-compose.yml"
    assert not re.search(r"^\s+ports:", compose, re.M), "Dokploy compose files use expose, not ports"
    assert "container_name" not in compose, "Dokploy compose files must not set container_name"

def unraid():
    root = ET.parse(f"{t}/unraid/tagave.xml").getroot()
    assert root.tag == "Container", "root element must be <Container>"
    for field in ("Name", "Repository", "WebUI", "Icon", "Overview"):
        assert root.find(field) is not None and (root.find(field).text or "").strip(), f"<{field}> is empty"
    targets = {c.get("Target") for c in root.findall("Config")}
    for need in ("DATABASE_URL", "APP_SECRET", "3000", "/cache"):
        assert need in targets, f"no <Config> for {need}"

def coolify():
    text = open(f"{t}/coolify/tagave.yml").read()
    for header in ("# documentation:", "# slogan:", "# tags:", "# port:"):
        assert header in text, f"missing Coolify header {header}"
    assert "SERVICE_URL_APP_3000" in text, "the app needs SERVICE_URL_APP_3000 for Coolify's proxy"

check("portainer/templates.json", portainer)
check("dokploy/meta.json + template.toml", dokploy)
check("unraid/tagave.xml", unraid)
check("coolify/tagave.yml headers", coolify)
sys.exit(1 if failed else 0)
PY

compose_files=("$T/compose.yml" "$T/dokploy/docker-compose.yml" "$T/coolify/tagave.yml")
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  for f in "${compose_files[@]}"; do
    if POSTGRES_PASSWORD=x APP_SECRET=x MUSIC_DIR=/tmp \
       SERVICE_PASSWORD_64_POSTGRES=x SERVICE_PASSWORD_64_APPSECRET=x \
       docker compose -p tagave-template-check -f "$f" config -q; then
      ok "$f (docker compose config)"
    else
      bad "$f rejected by docker compose config"
    fi
  done
elif python3 -c 'import yaml' 2>/dev/null; then
  for f in "${compose_files[@]}"; do
    if python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$f"; then ok "$f (YAML)"; else bad "$f is not valid YAML"; fi
  done
else
  bad "neither docker compose nor PyYAML is available to check the compose files"
fi

if [ "$fail" -ne 0 ]; then
  echo "template check failed" >&2
  exit 1
fi
echo "templates ok"
