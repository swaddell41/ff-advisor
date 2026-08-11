.PHONY: setup backend frontend ingest snapshot test

# Detect Python: prefer pyenv 3.12, fall back to system python3
PYTHON := $(shell \
	if [ -x "$(HOME)/.pyenv/versions/3.12.8/bin/python" ]; then \
		echo "$(HOME)/.pyenv/versions/3.12.8/bin/python"; \
	elif command -v python3 >/dev/null 2>&1; then \
		echo "python3"; \
	else \
		echo "python"; \
	fi)

# Detect npm: prefer nvm node 22, fall back to system npm
NPM := $(shell \
	if [ -x "$(HOME)/.nvm/versions/node/v22.19.0/bin/npm" ]; then \
		echo "$(HOME)/.nvm/versions/node/v22.19.0/bin/npm"; \
	else \
		echo "npm"; \
	fi)

# First-time setup: install Python + Node dependencies
setup:
	$(PYTHON) -m pip install -e "backend[dev]"
	$(NPM) install --prefix frontend

# Run the FastAPI dev server (hot-reload)
backend:
	cd backend && $(PYTHON) -m uvicorn app.main:app --reload --port 8000

# Run the Vite dev server
frontend:
	cd frontend && $(NPM) run dev

# Run the full Sleeper ingestion pipeline
ingest:
	cd backend && $(PYTHON) scripts/ingest_leagues.py

# Snapshot current RosterAudit values (run weekly)
snapshot:
	cd backend && $(PYTHON) scripts/snapshot_values.py

# Backfill roster_players table from cached Sleeper roster data (run once after upgrade)
backfill-rosters:
	cd backend && $(PYTHON) scripts/backfill_rosters.py

# Run the test suite
test:
	cd backend && $(PYTHON) -m pytest -v
