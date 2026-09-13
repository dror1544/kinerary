import json
import os
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from service import TaskControl, make_handler
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import Mock


class Tests(unittest.TestCase):
    def test_http_requires_its_own_trip_credential(self):
        control = Mock()
        control.snapshot.return_value = {'scheduler_running': True, 'tasks': []}
        token = 'a-dedicated-token-for-this-trip-only'
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(control, token))
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/tasks'
            for auth in ['', 'Bearer another-trip-token']:
                with self.assertRaises(HTTPError) as result:
                    urlopen(Request(url, headers={'Authorization': auth}))
                self.assertEqual(result.exception.code, 401)
            control.snapshot.assert_not_called()
            response = urlopen(Request(url, headers={'Authorization': 'Bearer ' + token}))
            self.assertEqual(json.load(response), {'scheduler_running': True, 'tasks': []})
            with self.assertRaises(HTTPError) as result:
                urlopen(Request(url, data=json.dumps({'id': 'one', 'action': 'pause', 'profile': 'other'}).encode(), headers={'Authorization': 'Bearer ' + token}))
            self.assertEqual(result.exception.code, 400)
            control.change.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_native_scheduler_scope_pause_resume_and_run(self):
        # Import Hermes only AFTER selecting a disposable profile. No live job
        # or gateway is started; trigger_job only changes its next-run timestamp.
        with tempfile.TemporaryDirectory(prefix='companion-control-test-') as root:
            home = Path(root)
            (home / 'config.yaml').write_text('timezone: UTC\n')
            os.environ['HERMES_HOME'] = root
            from cron import jobs
            with jobs.use_cron_store(home):
                job = jobs.create_job('Test encouragement', 'every 60m', name='Website update', deliver='local')
                hidden = jobs.create_job('Secret maintenance prompt', 'every 60m', name='Private maintenance', deliver='local')
                registry = [{'id': job['id'], 'label': {'he': 'עדכון', 'en': 'Update'}, 'audience': 'website'}]
                control = TaskControl(jobs, home, registry, lambda: 'UTC')
                first = control.snapshot()
                self.assertEqual([t['id'] for t in first['tasks']], [job['id']])
                self.assertNotIn('prompt', json.dumps(first))
                self.assertFalse(first['scheduler_running'])
                with self.assertRaises(ValueError):
                    control.change(job['id'], 'run')
                paused = control.change(job['id'], 'pause')
                self.assertFalse(paused['tasks'][0]['enabled'])
                self.assertEqual(jobs.get_job(job['id'])['prompt'], 'Test encouragement')
                with self.assertRaises(KeyError):
                    control.change(hidden['id'], 'pause')
                with self.assertRaises(ValueError):
                    control.change(job['id'], 'delete')
                jobs.record_ticker_heartbeat(success=True)
                with self.assertRaises(ValueError):
                    control.change(job['id'], 'run')
                resumed = control.change(job['id'], 'resume')
                self.assertTrue(resumed['tasks'][0]['enabled'])
                self.assertIsNotNone(resumed['tasks'][0]['next_run'])
                before = jobs.get_job(job['id'])['next_run_at']
                ran = control.change(job['id'], 'run')
                self.assertLess(ran['tasks'][0]['next_run'], before)
                self.assertTrue(jobs.get_job(hidden['id'])['enabled'])


if __name__ == '__main__':
    unittest.main()
