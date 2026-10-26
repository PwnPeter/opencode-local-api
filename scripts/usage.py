#!/usr/bin/env python3
"""Summarize private provider token counters by key and observed network route."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import sys

FIELDS = ('source', 'model', 'key_id', 'public_ip', 'proxy_url', 'interface', 'connection_uuid', 'usb_4g', 'mobile_data')
TOKENS = ('prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens')


def summarize(path, since=None, until=None):
    groups = {}
    if not path.exists():
        return {'combinations': []}
    with path.open() as journal:
        for index, line in enumerate(journal):
            if not line.endswith('\n'):
                break
            row = json.loads(line)
            if row.get('phase') not in ['inference', 'usage']:
                continue
            if since is not None or until is not None:
                settled = datetime.fromisoformat(row.get('timestamp') or row['started_at'])
                if (since is not None and settled < since) or (until is not None and settled >= until):
                    continue
            row['source'] = row.get('source') or 'legacy'
            identity = tuple(row.get(field) for field in FIELDS)
            if identity not in groups:
                groups[identity] = {**{field: row.get(field) for field in FIELDS}, 'key_number': row.get('key_number'),
                                    'requests': 0, 'accepted': 0, 'quota_errors': 0, 'network_errors': 0,
                                    'completed_streams': 0, 'interrupted_streams': 0,
                                    'tokens': dict.fromkeys(TOKENS), '_accepted': set(), '_measured': set()}
            group = groups[identity]
            group['key_number'] = row.get('key_number')
            request = row.get('request_id') or f'legacy-line-{index}'
            if row['phase'] == 'inference':
                group['requests'] += 1
                group['accepted'] += row.get('status') == 200
                group['quota_errors'] += row.get('quota_reached') is True
                group['network_errors'] += row.get('status') is None
                if row.get('status') == 200:
                    group['_accepted'].add(request)
            else:
                group['completed_streams'] += row.get('stream_complete') is True
                group['interrupted_streams'] += row.get('stream_complete') is False
                for token in TOKENS:
                    value = (row.get('usage') or {}).get(token)
                    if type(value) is int and value >= 0:
                        group['tokens'][token] = (group['tokens'][token] or 0) + value
                        group['_measured'].add(request)
    for group in groups.values():
        group['measured_requests'] = len(group['_measured'])
        group['unmeasured_accepted'] = len(group.pop('_accepted') - group.pop('_measured'))
    return {'combinations': list(groups.values())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('journal', nargs='?', type=Path, default=Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'opencode-local-api/attempts.jsonl')
    parser.add_argument('--since', type=datetime.fromisoformat, help='include records settled at or after this ISO timestamp')
    parser.add_argument('--until', type=datetime.fromisoformat, help='exclude records settled at or after this ISO timestamp')
    args = parser.parse_args()
    try:
        print(json.dumps(summarize(args.journal, args.since, args.until), indent=2))
    except (OSError, ValueError, TypeError, KeyError):
        print('Usage journal unavailable or invalid', file=sys.stderr)
        sys.exit(1)
