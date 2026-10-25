#!/usr/bin/env python3
"""Build a private pool of HTTPS-tested exits; VPN Gate uses isolated rootless containers."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import fcntl
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import random
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from install import private_write, read_environment

SOURCES = [
    ('proxyscrape', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text', None),
    ('proxifly', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt', None),
    ('monosans', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt', None),
    ('speedx-http', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', 'http'),
    ('speedx-socks5', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', 'socks5'),
    ('openproxylist-http', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', 'http'),
    ('openproxylist-socks5', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt', 'socks5'),
]
IMAGE = 'docker.io/qmcgaw/gluetun:v3'


def download(url):
    with urllib.request.urlopen(url, timeout=25) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        raise ValueError('Proxy source exceeds the size limit')
    return data.decode('utf-8-sig')


def public_proxies(data, protocol=None):
    result = []
    for line in data.splitlines():
        try:
            line = line.strip()
            if protocol and '://' not in line:
                line = f'{protocol}://{line}'
            url = urllib.parse.urlsplit(line)
            if url.scheme not in ['http', 'https', 'socks5', 'socks5h'] or not url.port or url.username or url.password:
                continue
            if not ipaddress.ip_address(url.hostname).is_global or url.path not in ['', '/'] or url.query or url.fragment:
                continue
            result.append(urllib.parse.urlunsplit(('socks5h' if url.scheme == 'socks5' else url.scheme, url.netloc, '', '', '')))
        except ValueError:
            continue
    return list(dict.fromkeys(result))


def probe(proxy):
    command = ['curl', '--disable', '--silent', '--show-error', '--ipv4', '--noproxy', '', '--proxy', proxy,
               '--connect-timeout', '5', '--max-time', '12', '--proto', '=https', '--max-filesize', '1048576']
    try:
        ipify = socket.getaddrinfo('api.ipify.org', 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
        ip = subprocess.check_output(command + ['--connect-to', f'api.ipify.org:443:{ipify}:443', '--fail', 'https://api.ipify.org'], stderr=subprocess.DEVNULL, timeout=15).decode().strip()
        observed = ipaddress.ip_address(ip)
        if observed.version != 4 or not observed.is_global:
            return None
        provider = socket.getaddrinfo('opencode.ai', 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
        status = subprocess.check_output(command + ['--connect-to', f'opencode.ai:443:{provider}:443', '--output', '/dev/null', '--write-out', '%{http_code}',
                                         'https://opencode.ai/inference/v1/models'], stderr=subprocess.DEVNULL, timeout=15).decode()
        if status != '200':
            return None
        return {'url': proxy, 'ip': ip}
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def public_exits(count, excluded=frozenset()):
    candidates = {}
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as workers:
        downloads = {workers.submit(download, url): (name, protocol) for name, url, protocol in SOURCES}
        for future in as_completed(downloads):
            name, protocol = downloads[future]
            try:
                found = [url for url in public_proxies(future.result(), protocol)
                         if urllib.parse.urlsplit(url).hostname not in excluded]
                sample = found[:64] + random.sample(found[64:], min(192, max(0, len(found) - 64)))
                for url in sample:
                    candidates.setdefault(url, name)
                print(f'{name}: {len(found)} candidates', flush=True)
            except (ValueError, OSError) as error:
                print(f'{name} unavailable: {type(error).__name__}', flush=True)
    shuffled = list(candidates)
    random.shuffle(shuffled)
    exits = {}
    with ThreadPoolExecutor(max_workers=32) as workers:
        futures = [workers.submit(probe, proxy) for proxy in shuffled]
        for future in as_completed(futures):
            result = future.result()
            if result and result['ip'] not in excluded and result['ip'] not in exits:
                exits[result['ip']] = {**result, 'source': candidates[result['url']]}
                print(f'Public HTTPS exit verified: {result["ip"]}', flush=True)
                if len(exits) >= count:
                    for queued in futures:
                        queued.cancel()
                    break
    return list(exits.values())


def safe_vpngate_config(encoded):
    config = base64.b64decode(encoded, validate=True).decode()
    if len(config) > 65536:
        raise ValueError('Oversized VPN Gate configuration')
    allowed = {'client', 'dev', 'proto', 'remote', 'cipher', 'data-ciphers', 'auth', 'resolv-retry',
               'nobind', 'persist-key', 'persist-tun', 'verb', 'remote-cert-tls', 'verify-x509-name',
               'connect-retry', 'connect-timeout', 'reneg-sec', 'tun-mtu'}
    block = None
    remote = False
    for raw in config.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if block:
            if line == f'</{block}>':
                block = None
            elif line.startswith('<'):
                raise ValueError('Invalid VPN Gate inline block')
            continue
        if line in ['<ca>', '<cert>', '<key>', '<tls-auth>', '<tls-crypt>']:
            block = line[1:-1]
            continue
        parts = shlex.split(line)
        if not parts or parts[0] not in allowed:
            raise ValueError('Unsafe VPN Gate directive')
        if parts[0] == 'remote':
            if len(parts) != 3 or not ipaddress.ip_address(parts[1]).is_global or not 0 < int(parts[2]) < 65536:
                raise ValueError('Invalid VPN Gate remote endpoint')
            remote = True
    if block or not remote:
        raise ValueError('Incomplete VPN Gate configuration')
    return config


def vpngate_exits(config_dir, count=2):
    if not shutil.which('podman'):
        print('VPN Gate requires rootless Podman; continuing with public proxies.', flush=True)
        return []
    try:
        rows = list(csv.DictReader(io.StringIO('\n'.join(download('https://www.vpngate.net/api/iphone/').splitlines()[1:]))))
        rows = sorted((r for r in rows if r.get('OpenVPN_ConfigData_Base64')), key=lambda r: int(r.get('Score') or 0), reverse=True)
        subprocess.run(['podman', 'pull', IMAGE], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    except (ValueError, OSError, subprocess.SubprocessError):
        print('VPN Gate list or container image unavailable.', flush=True)
        return []
    directory = config_dir / 'vpngate'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    exits = {}
    for row in rows[:6]:
        name = 'opencode-egress-' + hashlib.sha256(row['IP'].encode()).hexdigest()[:12]
        created = False
        try:
            config = safe_vpngate_config(row['OpenVPN_ConfigData_Base64'])
            exists = subprocess.run(['podman', 'container', 'exists', name]).returncode == 0
            if not exists:
                path = directory / f'{name}.ovpn'
                private_write(path, config)
                subprocess.run(['podman', 'run', '--detach', '--name', name, '--restart=unless-stopped',
                                '--cap-add=NET_ADMIN', '--device=/dev/net/tun', '--security-opt=label=disable',
                                '--publish', '127.0.0.1::8888', '--volume', f'{path}:/gluetun/custom.conf:ro',
                                '--env', 'VPN_SERVICE_PROVIDER=custom', '--env', 'VPN_TYPE=openvpn',
                                '--env', 'OPENVPN_CUSTOM_CONFIG=/gluetun/custom.conf', '--env', 'OPENVPN_USER=vpn',
                                '--env', 'OPENVPN_PASSWORD=vpn', '--env', 'HTTPPROXY=on', '--env', 'HTTPPROXY_STEALTH=on',
                                IMAGE], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                created = True
            else:
                subprocess.run(['podman', 'start', name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            port = subprocess.check_output(['podman', 'port', name, '8888/tcp'], text=True, timeout=10).strip()
            proxy = f'http://{port}'
            print(f'VPN Gate tunnel starting: {row["CountryLong"]} ({name})', flush=True)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                result = probe(proxy)
                if result:
                    exits[result['ip']] = {**result, 'source': 'vpngate', 'container': name, 'country': row['CountryLong']}
                    print(f'VPN Gate HTTPS exit verified: {result["ip"]}', flush=True)
                    break
                time.sleep(2)
            else:
                raise ValueError('VPN Gate tunnel did not become ready')
            if len(exits) >= count:
                break
        except (ValueError, OSError, subprocess.SubprocessError):
            print(f'VPN Gate relay unavailable: {name}', flush=True)
            if created:
                subprocess.run(['podman', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    return list(exits.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vpngate', action='store_true', help='also start two isolated rootless VPN Gate proxies')
    parser.add_argument('--refresh', action='store_true', help='replenish the running relay with a small batch of fresh exits')
    parser.add_argument('--output', type=Path, help='private pool file used by the relay')
    parser.add_argument('--exclude-ips', default='', help='known exit IPs, comma-separated or a JSON array on stdin with -')
    args = parser.parse_args()
    excluded = set(json.load(sys.stdin) if args.exclude_ips == '-' else filter(None, args.exclude_ips.split(',')))
    for ip in excluded:
        ipaddress.ip_address(ip)
    config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'opencode-local-api'
    config.mkdir(mode=0o700, parents=True, exist_ok=True)
    config.chmod(0o700)
    output = args.output.resolve() if args.output else config / 'proxies.json'
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    values = {} if args.refresh else read_environment(config / 'environment')
    keys = [values.get('OPENCODE_API_KEY'), values.get('OPENCODE_API_KEY_BACKUP'), *values.get('OPENCODE_API_KEYS', '').split(',')]
    minimum = 1 if args.refresh else max(2, len(set(filter(None, keys))) + 1)
    with ThreadPoolExecutor(max_workers=1) as worker:
        vpn = worker.submit(vpngate_exits, config) if args.vpngate else None
        exits = public_exits(4 if args.refresh else max(24, minimum), excluded)
        if vpn:
            exits = vpn.result() + exits
    exits = list({entry['ip']: entry for entry in reversed(exits)}.values())[::-1]
    if len(exits) < minimum:
        raise SystemExit(f'Only {len(exits)} verified exits; need {minimum}. Existing pool preserved.')
    with output.with_name(output.name + '.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = json.loads(output.read_text()) if output.exists() else []
        merged = list({entry['ip']: entry for entry in previous + exits}.values())
        private_write(output, json.dumps(merged, indent=2) + '\n')
    print(f'Pool saved: {len(merged)} distinct exit IPs, {len(exits)} verified this round. No API keys were sent.', flush=True)


if __name__ == '__main__':
    main()
