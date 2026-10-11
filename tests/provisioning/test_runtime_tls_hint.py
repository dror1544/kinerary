"""A Python whose CA store was never set up fails every HTTPS call with a bare
CERTIFICATE_VERIFY_FAILED traceback, mid-plan (2026-10-10: teardown-trip.py under the
python.org 3.9 on PATH). The transport names the cause and the interpreter to use."""
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from provisioning.runtime import HttpJsonTransport


class TlsHint(unittest.TestCase):
    def test_a_certificate_failure_names_the_interpreter_problem(self):
        transport = HttpJsonTransport("https://example.invalid", {})
        boom = URLError(ssl.SSLCertVerificationError("unable to get local issuer certificate"))
        with mock.patch("provisioning.runtime.urlopen", side_effect=boom):
            with self.assertRaises(RuntimeError) as ctx:
                transport.request("GET", "/x")
        message = str(ctx.exception)
        self.assertIn("certificate", message.lower())
        self.assertIn("preflight", message)  # points at the venv the preflight builds

    def test_other_network_errors_are_not_rewritten(self):
        transport = HttpJsonTransport("https://example.invalid", {})
        with mock.patch("provisioning.runtime.urlopen", side_effect=URLError("connection refused")):
            with self.assertRaises(URLError):
                transport.request("GET", "/x")


if __name__ == "__main__":
    unittest.main()
