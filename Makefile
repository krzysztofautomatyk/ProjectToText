.PHONY: help dev test lint build ui-install ui-build e2e pack-demo check

help:
	@echo "ptt — ProjectToText"
	@echo ""
	@echo "  make ui-install   Install frontend dependencies"
	@echo "  make dev          Run Tauri dev (requires tauri-cli)"
	@echo "  make test         Run Rust tests (core + CLI)"
	@echo "  make lint         Clippy + UI lint"
	@echo "  make ui-build     Production frontend build"
	@echo "  make e2e          Browser Playwright smoke tests"
	@echo "  make pack-demo    Headless pack of this repo (XML to /tmp)"
	@echo "  make build        Release app bundle (cargo tauri build)"
	@echo "  make check        test + lint + ui-build + e2e"

ui-install:
	npm --prefix ui install

dev:
	cargo tauri dev

test:
	cargo test

lint:
	cargo clippy --all-targets -- -D warnings
	npm --prefix ui run lint

ui-build:
	npm --prefix ui run build

e2e: ui-build
	npm --prefix ui run test:e2e

pack-demo:
	cargo build --release
	./target/release/ptt pack . -f xml -o /tmp/ptt-self-pack.xml --no-summary
	@wc -c /tmp/ptt-self-pack.xml

build: ui-build
	cargo tauri build

check: test lint ui-build e2e
	@echo "All checks passed."
