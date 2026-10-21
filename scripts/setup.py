#!/usr/bin/env python3
"""Guided relay and Harness setup; rerun to resume after an interruption."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

import install


HARNESS_VERSION = '0.2.1-rc.2'


def ask(question):
    while True:
        answer = input(f'{question} [Y/n] ').strip().lower()
        if answer in ('', 'y', 'yes', 'o', 'oui'):
            return True
        if answer in ('n', 'no', 'non'):
            return False
        print('Enter y or n.')


def prerequisites():
    if sys.platform != 'linux' or not shutil.which('systemctl'):
        raise ValueError('Linux with a systemd user session is required.')
    subprocess.run(['systemctl', '--user', 'show-environment'], check=True, stdout=subprocess.DEVNULL)
    packages = {'node': 'nodejs', 'npm': 'npm', 'curl': 'curl', 'make': 'make'}
    missing = [package for command, package in packages.items() if not shutil.which(command)]
    if missing:
        print('Required packages: ' + ', '.join(missing))
        if not ask('Install these packages with sudo?'):
            raise ValueError('Install the required packages, then rerun ./setup.')
        if shutil.which('apt-get'):
            subprocess.run(['sudo', 'apt-get', 'update'], check=True)
            subprocess.run(['sudo', 'apt-get', 'install', '-y', *missing], check=True)
        elif shutil.which('dnf'):
            subprocess.run(['sudo', 'dnf', 'install', '-y', *missing], check=True)
        else:
            raise ValueError('Automatic package installation supports apt and dnf. Install the listed packages and rerun ./setup.')
    version = tuple(int(part) for part in subprocess.check_output(['node', '-p', 'process.versions.node'], text=True).strip().split('.'))
    if not (version >= (24,) or (22, 19) <= version < (23,)):
        raise ValueError('Node.js 24+ or 22.19+ (22.x) is required: https://nodejs.org/en/download. Then rerun ./setup.')


def ensure_harness(prefix):
    binary = prefix / 'bin/dsh'
    if binary.is_file():
        result = subprocess.run([str(binary), '--version'], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip() == HARNESS_VERSION:
            print('Harness already installed; keeping it.')
            return binary
    print(f'Harness {HARNESS_VERSION} will be installed under {prefix}, without sudo.')
    if not ask('Install the Harness?'):
        raise ValueError('Relay installed. Rerun ./setup to finish the Harness setup.')
    subprocess.run(['npm', 'install', '--global', '--prefix', str(prefix), f'@deepseek-ai/dsh@{HARNESS_VERSION}'], check=True)
    return binary


def docker_setup():
    print('\nDocker mode installs the API. Connect your Harness or another client to it.\n', flush=True)
    subprocess.run(['docker', 'compose', 'version'], check=True)
    subprocess.run(['docker', 'info'], check=True, stdout=subprocess.DEVNULL)
    print('\n1/3 Build', flush=True)
    subprocess.run(['docker', 'compose', 'build'], check=True)
    print('\n2/3 API key\nGet your key: https://opencode.ai/console/\nAccount > Personal API keys > Add API key > Create\nSaved credentials and the verified protocol are reused on the next run.\n', flush=True)
    subprocess.run(['docker', 'compose', 'run', '--rm', 'relay', 'python3', 'scripts/install.py', 'prepare'], check=True)
    print('\n3/3 Start', flush=True)
    subprocess.run(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '600'], check=True)
    port = os.environ.get('RELAY_PORT') or '4097'
    print(f'\nReady: http://127.0.0.1:{port}/v1\nModel: deepseek-v4.1-flash-free\nClient token: docker compose exec relay cat /data/opencode-local-api/harness.env\nLogs: docker compose logs -f relay\nStop: docker compose down\nCredentials stay in the Docker volume.\n', flush=True)


def main():
    if not sys.stdin.isatty():
        raise ValueError('Run ./setup in a terminal to follow the setup guide.')
    os.chdir(install.ROOT)
    print('\n1  Native: local API + Harness\n2  Docker: API only, no Node installation on the host\n', flush=True)
    while True:
        mode = input('Installation [1/2] (1): ').strip() or '1'
        if mode in ('1', '2'):
            break
        print('Enter 1 or 2.')
    if mode == '2':
        docker_setup()
        return
    prefix = Path.home() / '.local'
    os.environ['PATH'] = str(prefix / 'bin') + os.pathsep + os.environ.get('PATH', '')
    print('\nOpenCode API setup\nYou can stop at any time and rerun ./setup to resume.\n', flush=True)
    print('1/4 Prerequisites', flush=True)
    prerequisites()
    print('\n2/4 Local API', flush=True)
    config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'opencode-local-api'
    if (config / 'environment').exists():
        print('Saved credentials found; no need to enter them again.')
    else:
        print('Get your key: https://opencode.ai/console/\nAccount > Personal API keys > Add API key > Create\nPaste it at the hidden prompt below. It stays in your private configuration.')
    if (config / 'envelope.json').exists():
        print('Verified protocol found; skipping download and extraction.')
    install.main()
    print('\n3/4 Harness', flush=True)
    ensure_harness(prefix)
    print('\n4/4 Ready\nAPI: http://127.0.0.1:4097/v1\nModel: deepseek-v4.1-flash-free\nThe API key and model are loaded automatically.\nIn the browser, choose your project folder to start.\nNext time: make harness\n', flush=True)
    if ask('Open the Harness now?'):
        print('Use the full sign-in URL printed below if your browser does not open.\n', flush=True)
        subprocess.run(['make', 'harness'], check=True)


def interrupted(signum, frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        sys.exit('\nStopped. Rerun ./setup to resume; saved credentials and completed steps are kept.')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f'\nSetup stopped: {error}\nFix the issue, then rerun ./setup to resume.')
