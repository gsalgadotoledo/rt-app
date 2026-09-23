"""Application API. Existing RT-App modules are delegated to the local Node core."""
import json, os, http.client
from functools import partial
from typing import Protocol
from rt_app_core import Singleton

class Greeter(Protocol):
    def hello(self) -> str: ...

class Greeting:
    def __init__(self, *, name: str):
        self.name = name
    def hello(self) -> str:
        return f"Hello from {self.name}"

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit
core = urlsplit(os.environ['RT_APP_CORE_API_URL'])
if core.scheme != 'http' or core.hostname != '127.0.0.1' or not core.port:
    raise RuntimeError('Core must be a loopback HTTP service')
HOP = {'host', 'connection', 'transfer-encoding', 'content-length', 'upgrade', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'}
class Handler(BaseHTTPRequestHandler):
    def handle_api(self):
        if self.path.split('?')[0] in ('/health', '/hello') and self.command == 'GET':
            value = {'ok': True} if self.path.split('?')[0] == '/health' else {'message': self.server.greeting.get().hello(), 'language': 'python'}
            body = json.dumps(value).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.headers.get('Transfer-Encoding'):
            self.send_error(400, 'Chunked request bodies are not supported'); return
        try: size = int(self.headers.get('Content-Length', '0'))
        except ValueError: self.send_error(400); return
        if size < 0 or size > 16384: self.send_error(413); return
        connection = http.client.HTTPConnection(core.hostname, core.port, timeout=15)
        try:
            # Never interpret the request path as an upstream URL.
            path = '/' + self.path.lstrip('/')
            connection.request(self.command, path, body=self.rfile.read(size), headers={k:v for k,v in self.headers.items() if k.lower() not in HOP})
            response = connection.getresponse(); data = response.read(4*1024*1024+1)
            if len(data)>4*1024*1024: raise RuntimeError('Core response too large')
            self.send_response(response.status)
            for key,value in response.getheaders():
                if key.lower() not in HOP: self.send_header(key,value)
            self.send_header('Content-Length',str(len(data))); self.end_headers()
            if self.command != 'HEAD': self.wfile.write(data)
        except (OSError, RuntimeError): self.send_error(502, 'RT-App core is unavailable')
        finally: connection.close()
    do_GET=do_POST=do_PUT=do_PATCH=do_DELETE=do_OPTIONS=do_HEAD=handle_api
if __name__ == '__main__':
    port=int(os.environ.get('PORT','4010'))
    print(f'Python API: http://localhost:{port}', flush=True)
    greeting: Singleton[Greeter] = Singleton(partial(Greeting, name="Python"))
    with greeting, ThreadingHTTPServer(('127.0.0.1',port), Handler) as server:
        server.greeting = greeting
        server.serve_forever()
