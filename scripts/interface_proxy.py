#!/usr/bin/env python3
"""Local TCP CONNECT relay pinned to one NetworkManager connection."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import select
import socket
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--interface', required=True)
parser.add_argument('--connection')
args = parser.parse_args()


class Proxy(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        remote = None
        try:
            host, port = self.path.rsplit(':', 1)
            if int(port) != 443:
                raise ValueError('Only HTTPS is allowed')
            if args.connection:
                connection = subprocess.check_output(['nmcli', '-g', 'GENERAL.CON-UUID', 'device', 'show', args.interface],
                                                     stderr=subprocess.DEVNULL, timeout=3).decode().strip()
                if connection != args.connection:
                    raise ValueError('The configured connection is unavailable')
            address = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
            remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            remote.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, args.interface.encode() + b'\0')
            remote.settimeout(8)
            remote.connect((address, 443))
            self.send_response(200, 'Connection established')
            self.end_headers()
            self.wfile.flush()
            while True:
                ready, _, _ = select.select([self.connection, remote], [], [], 300)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (remote if source is self.connection else self.connection).sendall(data)
        except (OSError, ValueError, subprocess.SubprocessError):
            self.close_connection = True
        finally:
            if remote:
                remote.close()


server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
server.daemon_threads = True
print(json.dumps({'url': 'http://127.0.0.1:' + str(server.server_port)}), flush=True)
server.serve_forever()
