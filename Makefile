.PHONY: infra-up infra-down backend frontend load-test test

infra-up:
	sh scripts/start-local.sh

infra-down:
	docker compose -f infrastructure/docker-compose.yml down

backend:
	cd backend && go run ./cmd/api

frontend:
	cd frontend && npm run dev

load-test:
	./load-test.sh

test:
	cd backend && go test ./...
	cd frontend && npm run lint && npm run build
