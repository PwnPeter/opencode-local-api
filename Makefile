.DEFAULT_GOAL := install
PYTHON ?= python3

.PHONY: install refresh verify start stop restart status logs test harness proxies usage

install:
	$(PYTHON) scripts/install.py

harness:
	@set -eu; \
	export PATH="$$HOME/.local/bin:$$PATH"; \
	set -a; \
	. "$${XDG_CONFIG_HOME:-$$HOME/.config}/opencode-local-api/harness.env"; \
	exec dsh web --patch "$(CURDIR)/config/dsh.patch.yml" --host 127.0.0.1 --port 0

refresh:
	$(PYTHON) scripts/install.py refresh

verify:
	$(PYTHON) scripts/install.py verify

proxies:
	$(PYTHON) scripts/proxies.py --vpngate

usage:
	@$(PYTHON) scripts/usage.py

start stop restart status:
	systemctl --user $@ opencode-local-api.service

logs:
	journalctl --user -u opencode-local-api.service -f

test:
	node --test
	$(PYTHON) -B -m unittest discover -s tests -p 'test_*.py' -v
