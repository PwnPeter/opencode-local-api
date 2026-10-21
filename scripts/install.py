#!/usr/bin/env python3
"""Extract the necessary native protocol, verify it, discard the native runtime."""
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.19.3'
CHECKSUMS = {
    'x64': '13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b',
    'arm64': '7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405',
}
SERVICE = 'opencode-local-api.service'


def read_environment(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            parts = shlex.split(line, comments=True)
            if not parts:
                continue
            if len(parts) != 1 or '=' not in parts[0]:
                raise ValueError(f'Invalid environment file: {path}')
            key, value = parts[0].split('=', 1)
            values[key] = value
    return values


def private_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text() == content:
        path.chmod(0o600)
        return False
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        file.write(content)
        temporary = Path(file.name)
    os.replace(temporary, path)
    return True


def unit_quote(value, executable=False):
    value = str(value)
    if any(char in value for char in '\0\n\r'):
        raise ValueError('Installation paths must not contain control characters')
    if executable:
        value = value.replace('$', '$$')
    return json.dumps(value, ensure_ascii=False).replace('%', '%%')


def credentials(config):
    existing = read_environment(config / 'environment')
    key = os.environ.get('OPENCODE_API_KEY') or existing.get('OPENCODE_API_KEY')
    if not key:
        if not sys.stdin.isatty():
            raise ValueError('Run the setup guide in a terminal to enter your OpenCode API key, or set OPENCODE_API_KEY')
        key = getpass.getpass('OpenCode API key (hidden): ').strip()
    values = {
        'OPENCODE_API_KEY': key,
        'OPENCODE_LOCAL_API_KEY': existing.get('OPENCODE_LOCAL_API_KEY') or secrets.token_urlsafe(32),
    }
    if any(not value or any(char in value for char in "\0\r\n'") for value in values.values()):
        raise ValueError('Credentials must be nonempty single-line values without apostrophes')
    return values


def save_credentials(config, values):
    config.mkdir(mode=0o700, parents=True, exist_ok=True)
    config.chmod(0o700)
    changed = private_write(config / 'environment', ''.join(f"{key}='{value}'\n" for key, value in values.items()))
    changed |= private_write(config / 'harness.env', f"OPENCODE_LOCAL_API_KEY='{values['OPENCODE_LOCAL_API_KEY']}'\n")
    return changed


def configure(project, config, units, node, values):
    changed = save_credentials(config, values)
    replacements = {
        '@ENVIRONMENT@': unit_quote(config / 'environment')[1:-1],
        '@ENVELOPE@': unit_quote(f'RELAY_ENVELOPE_FILE={config / "envelope.json"}'),
        '@NODE@': unit_quote(node, executable=True),
        '@SERVER@': unit_quote(project / 'src/server.mjs', executable=True),
    }
    unit = (project / 'config' / SERVICE).read_text()
    for name, value in replacements.items():
        unit = unit.replace(name, value)
    changed |= private_write(units / SERVICE, unit)
    return changed


def unpack_binary(archive, binary, expected):
    digest = hashlib.sha256()
    with archive.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError('OpenCode download checksum mismatch; existing binary preserved')
    with tarfile.open(archive, 'r:gz') as tar:
        member = tar.getmember('opencode')
        if not member.isfile():
            raise ValueError('OpenCode release must contain a regular opencode executable')
        with tar.extractfile(member) as source, tempfile.NamedTemporaryFile(dir=binary.parent, delete=False) as target:
            temporary = Path(target.name)
            shutil.copyfileobj(source, target)
    temporary.chmod(0o755)
    os.replace(temporary, binary)


def release(refresh):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if not arch:
        raise ValueError('Supported architectures: Linux x86_64 and ARM64')
    name = f'opencode-linux-{arch}.tar.gz'
    if refresh:
        metadata = json.loads(subprocess.check_output([
            'curl', '--fail', '--silent', '--show-error', '--proto', '=https', '--max-time', '30',
            'https://api.github.com/repos/anomalyco/opencode/releases/latest',
        ], text=True))
        asset = next((item for item in metadata['assets'] if item['name'] == name), None)
        if not asset or not asset.get('digest', '').startswith('sha256:'):
            raise ValueError('Official release has no SHA-256 for this platform')
        return metadata['tag_name'].removeprefix('v'), asset['browser_download_url'], asset['digest'][7:]
    return VERSION, f'https://github.com/anomalyco/opencode/releases/download/v{VERSION}/{name}', CHECKSUMS[arch]


def checked_run(command, env, label, timeout):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Native logs may contain credentials or private context; do not replay them.
        phase = next((name for name in ['streaming tool result', 'tool call', 'text']
                      if f'Check: {name}' in result.stdout), '')
        reason = re.search(r'HTTP [1-5]\d{2}|Text response check failed|Tool-call check failed|Streaming tool round-trip check failed|TimeoutError', result.stderr)
        detail = f'{reason.group()}; ' if reason else ''
        raise ValueError(f'{label} failed {"during " + phase if phase else ""} ({detail}exit {result.returncode}); current protocol preserved')


def verify(envelope, values, node):
    checked_run([str(node), str(ROOT / 'scripts/verify.mjs'), str(envelope)],
                {**os.environ, **values}, 'Text/tool/stream verification', 300)


def regenerate(config, values, node, refresh):
    version, url, digest = release(refresh)
    with tempfile.TemporaryDirectory(prefix='opencode-relay-') as tmp:
        work = Path(tmp)
        binary = work / 'opencode'
        print(f'Extracting OpenCode {version}; temporary runtime will be deleted...', flush=True)
        archive = work / 'release.tar.gz'
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--proto', '=https',
                        '--proto-redir', '=https', '--max-time', '180', '--output', str(archive), url], check=True)
        unpack_binary(archive, binary, digest)
        model = 'opencode/deepseek-v4.1-flash-free'
        settings = {
            'plugin': [(ROOT / 'scripts/extract.mjs').as_uri()], 'enabled_providers': ['opencode'],
            'model': model, 'small_model': model,
            'provider': {'opencode': {'whitelist': ['deepseek-v4.1-flash-free']}},
            'permission': {'*': 'allow'}, 'share': 'disabled', 'autoupdate': False,
        }
        (work / 'opencode.json').write_text(json.dumps(settings))
        candidate = work / 'envelope.json'
        env = {key: value for key, value in os.environ.items() if not key.startswith(('OPENCODE_', 'RELAY_'))}
        env.update({
            'HOME': tmp, 'XDG_CONFIG_HOME': str(work / 'config'), 'XDG_DATA_HOME': str(work / 'data'),
            'XDG_CACHE_HOME': str(work / 'cache'), 'XDG_STATE_HOME': str(work / 'state'),
            'OPENCODE_CONFIG': str(work / 'opencode.json'), 'OPENCODE_CONFIG_DIR': str(work / 'config/opencode'),
            'OPENCODE_API_KEY': values['OPENCODE_API_KEY'],
            'RELAY_ENVELOPE_OUTPUT': str(candidate), 'RELAY_VERSION': version,
        })
        marker = 'PROTOCOL_' + secrets.token_hex(12)
        checked_run([str(binary), 'run', '--dir', tmp, '--format', 'json', '--model', model,
                     '--title', 'Local relay protocol extraction', f'Reply exactly {marker}. Do not call tools.'],
                    env, 'Isolated native extraction', 240)
        if not candidate.is_file():
            raise ValueError('Native extraction produced no protocol; current protocol preserved')
        verify(candidate, values, node)
        content = candidate.read_text()
        if any(value in content for value in values.values()):
            raise ValueError('Extraction unexpectedly contains credentials; refusing to install')
        changed = private_write(config / 'envelope.json', content)
    print('Verified: text, tool call, tool result and complete streaming response. Native runtime removed.', flush=True)
    return changed


def main():
    if platform.system() != 'Linux':
        raise ValueError('Automatic installation requires Linux')
    action = sys.argv[1] if len(sys.argv) > 1 else 'install'
    if action not in ['install', 'refresh', 'verify', 'prepare'] or (sys.argv[2:] and (action != 'prepare' or sys.argv[2:] != ['--refresh'])):
        raise ValueError('Usage: install.py [install|refresh|verify|prepare [--refresh]]')
    commands = ['node', 'curl'] + ([] if action in ['prepare', 'verify'] else ['systemctl'])
    for command in commands:
        if not shutil.which(command):
            raise ValueError(f'Missing prerequisite: {command}')
    node = Path(shutil.which('node')).resolve()
    version = subprocess.check_output([str(node), '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise ValueError('Node.js 22 or newer is required')
    base = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config').resolve()
    config = base / 'opencode-local-api'
    config.mkdir(mode=0o700, parents=True, exist_ok=True)
    config.chmod(0o700)
    values = credentials(config)
    if action in ['install', 'prepare'] and not (config / 'environment').exists():
        # Keep first-install credentials if extraction is interrupted; preserve existing setups.
        save_credentials(config, values)
    if action == 'verify':
        verify(config / 'envelope.json', values, node)
        print('Verified: text, tool call, tool result and complete streaming response')
        return
    refresh = action == 'refresh' or '--refresh' in sys.argv[2:]
    if refresh or not (config / 'envelope.json').exists():
        regenerate(config, values, node, refresh)
    if action == 'prepare':
        save_credentials(config, values)
        print(f'Container configuration ready: {config}', flush=True)
        return
    was_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', SERVICE]).returncode == 0
    configure(ROOT, config, base / 'systemd/user', node, values)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', SERVICE], check=True)
    if was_active:
        subprocess.run(['systemctl', '--user', 'restart', SERVICE], check=True)
    checked_run([str(node), str(ROOT / 'src/server.mjs'), '--check'], {**os.environ, **values}, 'Local HTTP readiness', 20)
    # Remove only the former relay runtime; credentials and private backups stay.
    shutil.rmtree(ROOT / 'runtime', ignore_errors=True)
    shutil.rmtree(config / 'opencode', ignore_errors=True)
    (config / 'opencode.json').unlink(missing_ok=True)
    print('Ready: http://127.0.0.1:4097/v1 (automatic startup at user login)')
    print(f'Private local credential: {base / "opencode-local-api/harness.env"}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, KeyError) as error:
        sys.exit(f'Installation failed: {error}')
