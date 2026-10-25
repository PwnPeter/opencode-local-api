import base64
import importlib.util
from pathlib import Path
import unittest
import sys
import socket
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proxies', Path(__file__).resolve().parents[1] / 'scripts/proxies.py')


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(Path(spec.origin).parent))
        try:
            spec.loader.exec_module(self.module)
        finally:
            sys.path.pop(0)

    def test_untrusted_lists_only_produce_public_http_or_socks_endpoints(self):
        data = '\n'.join(['http://8.8.8.8:8080', 'http://8.8.8.8:8080', 'socks5://1.1.1.1:1080',
                          'http://127.0.0.1:80', 'http://169.254.169.254:80', 'file:///etc/passwd',
                          'http://user:pass@8.8.8.8:80', 'http://example.com:80', 'http://8.8.8.8:bad'])
        self.assertEqual(self.module.public_proxies(data), ['http://8.8.8.8:8080', 'socks5h://1.1.1.1:1080'])

    def test_vpngate_configs_reject_executable_directives_and_external_files(self):
        safe = 'client\ndev tun\nproto udp\nremote 8.8.8.8 1194\n<ca>\nfixture\n</ca>\n'
        self.assertIn('remote 8.8.8.8 1194', self.module.safe_vpngate_config(base64.b64encode(safe.encode()).decode()))
        for suffix in ['up /bin/sh\n', 'plugin /tmp/evil.so\n', 'config /etc/private\n', 'ca /etc/private\n', 'auth-user-pass /etc/private\n']:
            with self.assertRaises(ValueError):
                self.module.safe_vpngate_config(base64.b64encode((safe + suffix).encode()).decode())

    def test_raw_provider_lists_get_their_protocol_without_accepting_private_addresses(self):
        self.assertEqual(self.module.public_proxies('8.8.8.8:8080\n127.0.0.1:80\n', 'http'), ['http://8.8.8.8:8080'])
        self.assertEqual(self.module.public_proxies('1.1.1.1:1080\n', 'socks5'), ['socks5h://1.1.1.1:1080'])

    def test_discovery_excludes_both_known_endpoints_and_known_exit_ips(self):
        sources = [('fixture', 'https://source.invalid/list', None)]
        def probe(url):
            return {'url': url, 'ip': '1.1.1.1' if '8.8.8.8' in url else '9.9.9.9'}
        with patch.object(self.module, 'SOURCES', sources), \
             patch.object(self.module, 'download', return_value='http://8.8.8.8:80\nhttp://9.9.9.9:80\n'), \
             patch.object(self.module, 'probe', side_effect=probe):
            result = self.module.public_exits(1, {'1.1.1.1'})
        self.assertEqual(result, [{'url': 'http://9.9.9.9:80', 'ip': '9.9.9.9', 'source': 'fixture'}])

    def test_probe_uses_the_same_literal_ipv4_tunnels_as_runtime(self):
        with patch.object(socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]) as lookup, \
                patch.object(self.module.subprocess, 'check_output', side_effect=[b'8.8.8.8', b'200']) as request:
            result = self.module.probe('socks5h://9.9.9.9:1080')
        self.assertEqual(result['ip'], '8.8.8.8')
        for call, hostname in zip(request.call_args_list, ['api.ipify.org', 'opencode.ai']):
            command = call.args[0]
            self.assertIn('--connect-to', command)
            self.assertEqual(command[command.index('--connect-to') + 1], hostname + ':443:1.1.1.1:443')
        self.assertEqual(lookup.call_count, 2)
        for call in lookup.call_args_list:
            self.assertEqual(call.args[2], socket.AF_INET)


if __name__ == '__main__':
    unittest.main()
