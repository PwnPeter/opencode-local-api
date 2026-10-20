.DEFAULT_GOAL := install
PYTHON ?= python3

.PHONY: install refresh verify start stop restart status logs test

install:
	$(PYTHON) install.py

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
