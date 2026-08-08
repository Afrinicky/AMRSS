.DEFAULT_GOAL := help
COMPOSE := docker compose -f infra/docker/docker-compose.yml
API := apps/api

.PHONY: help
help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install backend and frontend dependencies
	cd $(API) && uv sync --all-extras
	cd apps/web && npm install
	cd apps/uploader && npm install

.PHONY: dev-up
dev-up: ## Start the full stack (Postgres, API, web) with migrations and seed data
	$(COMPOSE) up -d --build
	$(MAKE) migrate
	$(MAKE) seed

.PHONY: dev-down
dev-down: ## Stop the stack, preserving volumes
	$(COMPOSE) down

.PHONY: db-up
db-up: ## Start only Postgres (for running the API on the host)
	$(COMPOSE) up -d postgres

.PHONY: migrate
migrate: ## Apply database migrations
	cd $(API) && uv run alembic upgrade head

.PHONY: revision
revision: ## Generate a migration: make revision m="add x"
	cd $(API) && uv run alembic revision --autogenerate -m "$(m)"

.PHONY: seed
seed: ## Load reference data, methodology defaults and the demo regional block
	cd $(API) && uv run python -m amrss.seed

.PHONY: api
api: ## Run the API in reload mode
	cd $(API) && uv run uvicorn amrss.main:app --reload --port 8000

.PHONY: web
web: ## Run the dashboard in dev mode
	cd apps/web && npm run dev

.PHONY: uploader
uploader: ## Run the offline uploader in dev mode
	cd apps/uploader && npm run dev

.PHONY: test
test: ## Run the backend test suite
	cd $(API) && uv run pytest -q

.PHONY: lint
lint: ## Lint and type-check everything
	cd $(API) && uv run ruff check . && uv run ruff format --check . && uv run mypy amrss
	cd apps/web && npm run lint
	cd apps/uploader && npm run lint

.PHONY: fmt
fmt: ## Auto-format
	cd $(API) && uv run ruff format . && uv run ruff check --fix .

.PHONY: fixture
fixture: ## Regenerate the synthetic WHONET SQLite fixture
	cd $(API) && uv run python -m tests.fixtures.make_whonet_fixture
