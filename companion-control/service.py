"""One trip profile, one credential, explicitly registered traveler-facing tasks.
Run with the Hermes venv; never reads or edits a different profile's cron store.
"""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit


class TaskControl:
    def __init__(self, jobs, home, registry, timezone):
        self.jobs, self.home, self.timezone = jobs, home, timezone
        self.registry = {entry['id']: entry for entry in registry}
        self.lock = RLock()

    def snapshot(self):
        with self.lock, self.jobs.use_cron_store(self.home):
            tasks = []
            for job in self.jobs.list_jobs(include_disabled=True):
                entry = self.registry.get(job['id'])
                if not entry or job.get('state') in ('completed', 'failed', 'cancelled'):
                    continue
                tasks.append({
                    'id': job['id'], 'label': entry['label'], 'audience': entry['audience'],
                    'enabled': bool(job.get('enabled', True)),
                    'schedule': str(job.get('schedule_display') or ''),
                    'timezone': self.timezone(), 'next_run': job.get('next_run_at'),
                })
            ages = [self.jobs.get_ticker_heartbeat_age(), self.jobs.get_ticker_success_age()]
            return {'scheduler_running': all(age is not None and 0 <= age < 180 for age in ages), 'tasks': tasks}

    def change(self, task_id, action):
        with self.lock, self.jobs.use_cron_store(self.home):
            state = self.snapshot()
            task = next((task for task in state['tasks'] if task['id'] == task_id), None)
            if task is None:
                raise KeyError('task_not_found')
            if action == 'run':
                # Hermes trigger_job also resumes a paused job. Do not silently
                # change its persistent on/off preference as a side effect.
                if not task['enabled'] or not state['scheduler_running']:
                    raise ValueError('task_must_be_enabled_and_scheduler_running')
                operation = self.jobs.trigger_job
            elif action == 'pause':
                operation = self.jobs.pause_job
            elif action == 'resume':
                operation = self.jobs.resume_job
            else:
                raise ValueError('invalid_action')
            if operation(task_id) is None:
                raise KeyError('task_not_found')
            return self.snapshot()


def make_handler(control, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # no credential, job identifier, or response logging

        def respond(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def dispatch(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                return self.respond(401, {'error': 'unauthorized'})
            path = urlsplit(self.path).path
            try:
                if self.command == 'GET' and path == '/tasks':
                    return self.respond(200, control.snapshot())
                if self.command == 'POST' and path == '/tasks':
                    size = int(self.headers.get('Content-Length', '0'))
                    if size <= 0 or size > 1024:
                        return self.respond(400, {'error': 'invalid_request'})
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict) or set(body) != {'id', 'action'} or not all(isinstance(v, str) for v in body.values()):
                        return self.respond(400, {'error': 'invalid_request'})
                    return self.respond(200, control.change(body['id'], body['action']))
                return self.respond(404, {'error': 'not_found'})
            except KeyError:
                return self.respond(404, {'error': 'task_not_found'})
            except (ValueError, TypeError):
                return self.respond(409, {'error': 'task_change_refused'})
            except Exception:
                return self.respond(503, {'error': 'scheduler_unavailable'})

        do_GET = dispatch
        do_POST = dispatch
    return Handler


def main():
    # Explicit path mandatory: never silently fall back to a personal default.
    home = Path(os.environ['COMPANION_PROFILE_HOME']).expanduser().resolve(strict=True)
    if home.name == '.hermes' or not (home / 'config.yaml').is_file():
        raise ValueError('An explicit trip profile with config.yaml is required')
    token = Path(os.environ['COMPANION_CONTROL_TOKEN_FILE']).read_text().strip()
    if len(token) < 32:
        raise ValueError('Use a dedicated token of at least 32 characters')
    entries = json.loads(Path(os.environ['COMPANION_TASK_REGISTRY']).read_text())
    if not isinstance(entries, list) or len({entry['id'] for entry in entries}) != len(entries):
        raise ValueError('Invalid task registry')
    for entry in entries:
        if (not isinstance(entry['id'], str) or not entry['id']
                or entry['audience'] not in ('website', 'group', 'private')
                or not all(isinstance(entry['label'].get(lang), str) and 0 < len(entry['label'][lang]) <= 100 for lang in ('he', 'en'))):
            raise ValueError('Invalid task registry entry')
    os.environ['HERMES_HOME'] = str(home)
    from cron import jobs
    from hermes_time import now
    control = TaskControl(jobs, home, entries, lambda: str(now().tzinfo))
    server = ThreadingHTTPServer((os.environ.get('COMPANION_CONTROL_HOST', '127.0.0.1'), int(os.environ.get('COMPANION_CONTROL_PORT', '4326'))), make_handler(control, token))
    server.serve_forever()


if __name__ == '__main__':
    main()
