.DEFAULT_GOAL := install
PYTHON ?= python3

.PHONY: install refresh verify start stop restart status logs test harness

install:
	$(PYTHON) install.py

harness:
	@set -eu; \
	export PATH="$$HOME/.local/bin:$$PATH"; \
	set -a; \
	. "$${XDG_CONFIG_HOME:-$$HOME/.config}/opencode-local-api/harness.env"; \
	exec dsh web --patch "$(CURDIR)/dsh.patch.yml" --host 127.0.0.1 --port 0

refresh:
	$(PYTHON) install.py refresh

verify:
	$(PYTHON) install.py verify

start stop restart status:
	systemctl --user $@ opencode-local-api.service

logs:
	journalctl --user -u opencode-local-api.service -f

test:
	node --test
	$(PYTHON) -m unittest -v test_install.py
