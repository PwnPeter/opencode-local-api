import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class UsageSummaryTests(unittest.TestCase):
    def test_combination_totals_separate_probes_and_count_missing_usage_without_inventing_tokens(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'usage.py'
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'attempts.jsonl'
            base = {'source': 'relay', 'key_id': '111111111111', 'key_number': 1, 'public_ip': '198.51.100.1',
                    'proxy_url': None, 'interface': 'wifi', 'connection_uuid': 'home', 'model': 'fixture'}
            rows = []
            for request in ['first', 'second', 'missing', 'pending']:
                rows.append({**base, 'request_id': request, 'phase': 'inference', 'status': 200})
            rows.extend([
                {**base, 'request_id': 'first', 'phase': 'usage', 'stream_complete': True,
                 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120, 'cached_tokens': 60, 'reasoning_tokens': 5}},
                {**base, 'request_id': 'second', 'phase': 'usage', 'stream_complete': False,
                 'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}},
                {**base, 'request_id': 'missing', 'phase': 'usage', 'stream_complete': True, 'usage': None},
                {**base, 'request_id': 'quota', 'phase': 'inference', 'status': 429, 'quota_reached': True},
                {**base, 'source': 'probe', 'request_id': 'probe', 'phase': 'inference', 'status': 200},
                {**base, 'source': 'probe', 'request_id': 'probe', 'phase': 'usage', 'stream_complete': True,
                 'usage': {'prompt_tokens': 5, 'completion_tokens': 2, 'total_tokens': 7}},
                {**base, 'key_id': '222222222222', 'key_number': 2, 'request_id': 'other-key', 'phase': 'inference', 'status': 429, 'quota_reached': True},
            ])
            log.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            result = subprocess.run(['python3', str(script), str(log)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            groups = json.loads(result.stdout)['combinations']
            self.assertEqual(len(groups), 3)
            relay = next(row for row in groups if row['source'] == 'relay' and row['key_number'] == 1)
            self.assertEqual(relay['requests'], 5)
            self.assertEqual(relay['accepted'], 4)
            self.assertEqual(relay['quota_errors'], 1)
            self.assertEqual(relay['measured_requests'], 2)
            self.assertEqual(relay['unmeasured_accepted'], 2)
            self.assertEqual(relay['completed_streams'], 2)
            self.assertEqual(relay['interrupted_streams'], 1)
            self.assertEqual(relay['tokens'], {'prompt_tokens': 110, 'completion_tokens': 23, 'total_tokens': 133,
                                             'cached_tokens': 60, 'reasoning_tokens': 5})
            probe = next(row for row in groups if row['source'] == 'probe')
            self.assertEqual(probe['tokens']['total_tokens'], 7)
            unknown = next(row for row in groups if row['key_number'] == 2)
            self.assertIsNone(unknown['tokens']['total_tokens'])

    def test_missing_journal_is_reported_without_creating_private_state(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'usage.py'
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(['python3', str(script)], env={**os.environ, 'XDG_CONFIG_HOME': tmp},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'combinations': []})
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_since_uses_settlement_time_so_pending_requests_keep_their_reported_usage(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'usage.py'
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'attempts.jsonl'
            base = {'source': 'relay', 'key_id': '111111111111', 'key_number': 1, 'public_ip': '198.51.100.1'}
            rows = [
                {**base, 'timestamp': '2026-10-26T00:00:00Z', 'request_id': 'old', 'phase': 'usage', 'usage': {'total_tokens': 999}},
                {**base, 'timestamp': '2026-10-26T00:02:00Z', 'started_at': '2026-10-26T00:00:00Z',
                 'request_id': 'pending', 'phase': 'usage', 'usage': {'total_tokens': 120}},
                {**base, 'timestamp': '2026-10-26T00:04:00Z', 'request_id': 'later', 'phase': 'usage', 'usage': {'total_tokens': 888}},
            ]
            log.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            result = subprocess.run(['python3', str(script), str(log), '--since', '2026-10-26T01:01:00+01:00', '--until', '2026-10-26T00:03:00Z'],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            groups = json.loads(result.stdout)['combinations']
            self.assertEqual(groups[0]['tokens']['total_tokens'], 120)


if __name__ == '__main__':
    unittest.main()
