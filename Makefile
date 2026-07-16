.PHONY: help dev test lint build ui-install ui-build check

help:
	@echo "ptt — ProjectToText"
	@echo ""
	@echo "  make ui-install   Install frontend dependencies"
	@echo "  make dev          Run Tauri dev (requires tauri-cli)"
	@echo "  make test         Run Rust tests"
	@echo "  make lint         Clippy + UI lint"
	@echo "  make ui-build     Production frontend build"
	@echo "  make build        Release app bundle (cargo tauri build)"
	@echo "  make check        test + lint + ui-build"

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

build: ui-build
	cargo tauri build

check: test lint ui-build
	@echo "All checks passed."
