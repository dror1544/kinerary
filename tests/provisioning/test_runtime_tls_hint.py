"""A Python whose CA store was never set up fails every HTTPS call with a bare
CERTIFICATE_VERIFY_FAILED traceback, mid-plan (2026-10-10: teardown-trip.py under the
python.org 3.9 on PATH). The transport names the cause and the interpreter to use -- but
only when the verification code says the trust store is the problem. An expired or
mismatched certificate is the server's fault and no interpreter switch fixes it (#361 review)."""
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from provisioning.runtime import HttpJsonTransport


def cert_error(verify_code, verify_message):
    exc = ssl.SSLCertVerificationError(
        1, f"[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: {verify_message}")
    exc.verify_code = verify_code
    exc.verify_message = verify_message
    return exc


class TlsHint(unittest.TestCase):
    def _raise_for(self, exc):
        transport = HttpJsonTransport("https://example.invalid", {})
        with mock.patch("provisioning.runtime.urlopen", side_effect=URLError(exc)):
            with self.assertRaises(RuntimeError) as ctx:
                transport.request("GET", "/x")
        return str(ctx.exception)

    def test_missing_issuer_gets_the_ca_bundle_hint(self):
        message = self._raise_for(cert_error(20, "unable to get local issuer certificate"))
        self.assertIn("unable to get local issuer certificate", message)
        self.assertIn("CA bundle", message)
        self.assertIn("preflight", message)  # points at the venv the preflight builds
        self.assertIn("Install Certificates.command", message)

    def test_self_signed_in_chain_gets_the_ca_bundle_hint(self):
        message = self._raise_for(cert_error(19, "self-signed certificate in certificate chain"))
        self.assertIn("self-signed certificate in certificate chain", message)
        self.assertIn("CA bundle", message)
        self.assertIn("preflight", message)

    def test_every_trust_store_code_gets_the_hint(self):
        for code in (18, 19, 20, 21):
            with self.subTest(code=code):
                self.assertIn("CA bundle", self._raise_for(cert_error(code, "issuer problem")))

    def test_expired_certificate_keeps_its_reason_and_gets_no_ca_advice(self):
        message = self._raise_for(cert_error(10, "certificate has expired"))
        self.assertIn("certificate has expired", message)
        self.assertIn("expired", message.lower())
        self.assertNotIn("CA bundle", message)
        self.assertNotIn("preflight", message)
        self.assertNotIn("Install Certificates", message)

    def test_hostname_mismatch_keeps_its_reason_and_gets_no_ca_advice(self):
        message = self._raise_for(cert_error(62, "Hostname mismatch, certificate is not valid for 'example.invalid'."))
        self.assertIn("Hostname mismatch", message)
        self.assertIn("different host name", message)
        self.assertNotIn("CA bundle", message)
        self.assertNotIn("preflight", message)

    def test_unknown_code_keeps_its_reason_and_gets_no_ca_advice(self):
        message = self._raise_for(cert_error(9999, "something new"))
        self.assertIn("something new", message)
        self.assertNotIn("CA bundle", message)

    def test_other_network_errors_are_not_rewritten(self):
        transport = HttpJsonTransport("https://example.invalid", {})
        with mock.patch("provisioning.runtime.urlopen", side_effect=URLError("connection refused")):
            with self.assertRaises(URLError):
                transport.request("GET", "/x")


if __name__ == "__main__":
    unittest.main()
