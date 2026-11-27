"""control_plane_worker/trip_container.py: the client of the trip-container host's forced command, and the
worker's own writes into a trip's directory on the document store.

Spec: docs/specs/sprint-9/x-trip-vm-container-placement.md. The host's side of the contract is
scripts/trip-container-host.sh; tests/scripts/test_trip_container_worker_contract.py runs THIS client against
the real script, so a drift between the two goes red there.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from control_plane_worker.trip_container import (
    DockerSiteAdapter, ReleaseNotVerified, TripContainerError, TripContainerRefused, TripContainerUnreachable,
    TripImageMissing, TripStore, TripStoreError, image_digest, ssh_transport, validate_ip_pool,
)

from tests.support.fake_trip_host import FakeTripHost

TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
SLUG = "alsace-2026"
DIGEST = "ab" * 32
BRIDGE = "http://bridge.test:4310"
PASSWORD = "k7mq-x3ra-pw9d-hn4t"
KEY = "ek" + "9" * 30


class ClientCase(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="trip-container-client-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.host = FakeTripHost(self.work, images={DIGEST}, bridge_url=BRIDGE)
        self.client = DockerSiteAdapter(self.host, bridge_url=BRIDGE)


class RequestShapeTests(ClientCase):
    def test_ensure_sends_the_contracts_fields_and_the_bridge_url_it_was_given(self) -> None:
        answer = self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD,
                                    exchange_key=KEY, public_origin="https://alsace-2026.trips.example.invalid",
                                    trip_mcp_enabled=True)
        self.assertTrue(answer["ok"])
        self.assertEqual({
            "record_type": "trip_container_request", "verb": "ensure", "trip_id": TRIP_ID, "slug": SLUG,
            "ip": "10.250.0.10", "image": DIGEST, "seed_password": PASSWORD, "exchange_key": KEY,
            "hermes_url": BRIDGE, "public_origin": "https://alsace-2026.trips.example.invalid", "trip_mcp_enabled": True,
        }, self.host.requests[0])

    def test_an_absent_exchange_key_is_not_sent_at_all(self) -> None:
        self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD, exchange_key=None)
        self.assertNotIn("exchange_key", self.host.requests[0])
        self.assertNotIn("trip_mcp_enabled", self.host.requests[0])

    def test_read_sends_candidates_only_with_the_kind_and_the_bridge_only_with_site_to_bridge(self) -> None:
        self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD, exchange_key=KEY)
        self.client.read(TRIP_ID, SLUG, ["seed_password"])
        self.client.read(TRIP_ID, SLUG, ["exchange_key_kind"], exchange_key_candidates={"shared": KEY})
        self.client.read(TRIP_ID, SLUG, ["site_to_bridge"])
        reads = [r for r in self.host.requests if r["verb"] == "read"]
        self.assertEqual({"fields": ["seed_password"]}, {k: reads[0][k] for k in reads[0] if k not in
                                                         ("record_type", "verb", "trip_id", "slug")})
        self.assertEqual({"shared": KEY}, reads[1]["exchange_key_candidates"])
        self.assertNotIn("bridge_url", reads[1])
        self.assertEqual(BRIDGE, reads[2]["bridge_url"])
        self.assertNotIn("exchange_key_candidates", reads[2])

    def test_read_gives_back_only_what_it_was_asked_and_the_site_password_on_request(self) -> None:
        self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD, exchange_key=KEY)
        answer = self.client.read(TRIP_ID, SLUG, ["seed_password", "exchange_key_kind"],
                                  exchange_key_candidates={"derived": "x" * 20, "shared": KEY})
        self.assertEqual(PASSWORD, answer["seed_password"])
        self.assertEqual("shared", answer["exchange_key_kind"])

    def test_deploy_names_the_way_back(self) -> None:
        self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD)
        self.host.images.add("cd" * 32)
        answer = self.client.deploy(TRIP_ID, SLUG, ip="10.250.0.10", image="cd" * 32)
        self.assertEqual(f"trip-site:{DIGEST}", answer["previous_image"])

    def test_a_value_the_host_would_refuse_is_stopped_here_with_a_name(self) -> None:
        for kwargs, words in (
            ({"image": "sha256:" + DIGEST}, "release digest"),
            ({"image": DIGEST, "ip": "10.250.0.010"}, "IPv4"),
            ({"image": DIGEST, "seed_password": "short"}, "seed password"),
            ({"image": DIGEST, "exchange_key": "has a space in it " * 2}, "exchange key"),
            ({"image": DIGEST, "public_origin": "http://x.example"}, "https origin"),
        ):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(TripContainerError, words):
                self.client.ensure(TRIP_ID, SLUG, **{"ip": "10.250.0.10", **kwargs})
        self.assertEqual([], self.host.requests, "nothing went out")

    def test_a_secret_that_is_refused_here_is_not_in_the_message(self) -> None:
        with self.assertRaises(TripContainerError) as caught:
            self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password="bad password!")
        self.assertNotIn("bad password", str(caught.exception))

    def test_a_trip_id_is_mandatory_and_never_falls_back_to_the_slug(self) -> None:
        for bad in ("", None, SLUG, "trip_XYZ"):
            with self.subTest(trip_id=bad), self.assertRaisesRegex(TripContainerError, "trip id"):
                self.client.check(bad, SLUG)  # type: ignore[arg-type]

    def test_a_missing_bridge_url_is_refused_at_construction(self) -> None:
        with self.assertRaisesRegex(ValueError, "TRIP_CONTAINER_BRIDGE_URL"):
            DockerSiteAdapter(self.host, bridge_url="")


class AnswerTests(ClientCase):
    def test_a_refusal_is_a_refusal_with_the_hosts_reason(self) -> None:
        self.host.refuse_with["deploy"] = "the trip has no store yet: run ensure first"
        with self.assertRaisesRegex(TripContainerRefused, "no store yet"):
            self.client.deploy(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST)

    def test_an_image_the_host_lacks_names_the_command_that_builds_it(self) -> None:
        other = "cd" * 32
        with self.assertRaises(TripImageMissing) as caught:
            self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=other, seed_password=PASSWORD)
        text = str(caught.exception)
        self.assertIn("kinerary-cp-release trip-image", text)
        self.assertIn("sha256:" + other, text)
        self.assertEqual("TRIP_IMAGE_MISSING", caught.exception.safe_error_code)

    def test_check_answers_even_when_the_site_is_not_healthy(self) -> None:
        self.client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD)
        self.host.unhealthy_checks = 1
        self.assertFalse(self.client.check(TRIP_ID, SLUG)["healthy"])
        self.assertTrue(self.client.check(TRIP_ID, SLUG)["healthy"])

    def test_an_exit_status_one_answer_is_parsed_whatever_the_status(self) -> None:
        # the host answers a failure with exit 1 and JSON on stdout; the client reads the JSON on every status
        calls = [(1, b'{"ok":false,"error":"failed","reason":"docker run failed"}\n')]
        client = DockerSiteAdapter(lambda payload: calls[0], bridge_url=BRIDGE)
        with self.assertRaisesRegex(TripContainerError, "docker run failed"):
            client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD)

    def test_stop_of_a_container_that_is_not_there_can_be_tolerated_and_nothing_else_is(self) -> None:
        self.assertTrue(self.client.stop(TRIP_ID, SLUG, missing_ok=True)["ok"])
        with self.assertRaisesRegex(TripContainerError, "no such container"):
            self.client.stop(TRIP_ID, SLUG)
        self.host.refuse_with["stop"] = "no such container (but refused)"
        with self.assertRaises(TripContainerRefused):
            self.client.stop(TRIP_ID, SLUG, missing_ok=True)

    def test_no_answer_is_unreachable_and_says_nothing_about_the_trip(self) -> None:
        for status, out in ((255, b""), (0, b"not json"), (0, b'{"ok": "yes"}'), (1, b"[]")):
            with self.subTest(status=status, out=out):
                client = DockerSiteAdapter(lambda payload, s=status, o=out: (s, o), bridge_url=BRIDGE)
                with self.assertRaises(TripContainerUnreachable):
                    client.check(TRIP_ID, SLUG)

    def test_an_error_never_carries_the_output_it_could_not_parse(self) -> None:
        client = DockerSiteAdapter(lambda payload: (1, b"SEED_PASSWORD=" + PASSWORD.encode() + b"\n"), bridge_url=BRIDGE)
        with self.assertRaises(TripContainerUnreachable) as caught:
            client.check(TRIP_ID, SLUG)
        self.assertNotIn(PASSWORD, str(caught.exception))

    def test_the_hosts_reason_is_flattened_and_bounded(self) -> None:
        reason = "line one\nline two \x1b[31m" + "x" * 500
        client = DockerSiteAdapter(
            lambda payload: (2, json.dumps({"ok": False, "error": "refused", "reason": reason}).encode()), bridge_url=BRIDGE)
        with self.assertRaises(TripContainerRefused) as caught:
            client.start(TRIP_ID, SLUG)
        self.assertNotIn("\n", str(caught.exception))
        self.assertNotIn("\x1b", str(caught.exception))
        self.assertLess(len(str(caught.exception)), 300)


class SshTransportTests(unittest.TestCase):
    def test_the_secrets_travel_on_stdin_and_never_on_the_command_line(self) -> None:
        seen = {}

        def fake_run(argv, **kwargs):
            seen["argv"], seen["input"] = argv, kwargs.get("input")
            return subprocess.CompletedProcess(argv, 0, stdout=b'{"ok":true}\n', stderr=b"")

        send = ssh_transport("host.invalid", "tripctl", "/keys/k", "/keys/known_hosts")
        with mock.patch("subprocess.run", fake_run):
            client = DockerSiteAdapter(send, bridge_url=BRIDGE)
            client.ensure(TRIP_ID, SLUG, ip="10.250.0.10", image=DIGEST, seed_password=PASSWORD, exchange_key=KEY)
        joined = " ".join(seen["argv"])
        for secret in (PASSWORD, KEY):
            self.assertNotIn(secret, joined)
            self.assertIn(secret.encode(), seen["input"])
        self.assertEqual(["ssh"], seen["argv"][:1])
        self.assertEqual("tripctl@host.invalid", seen["argv"][-1], "no remote command: the key's forced command decides")
        self.assertIn("UserKnownHostsFile=/keys/known_hosts", joined)
        self.assertIn("StrictHostKeyChecking=yes", joined)

    def test_a_timeout_is_unreachable_and_longer_than_the_hosts_own_ceiling(self) -> None:
        def slow(argv, **kwargs):
            self.assertGreater(kwargs["timeout"], 600)
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

        with mock.patch("subprocess.run", slow), self.assertRaises(TripContainerUnreachable):
            ssh_transport("h", "u", "/k", "/kh")(b"{}")

    def test_ssh_that_cannot_start_is_unreachable(self) -> None:
        with mock.patch("subprocess.run", side_effect=FileNotFoundError("ssh")), self.assertRaises(TripContainerUnreachable):
            ssh_transport("h", "u", "/k", "/kh")(b"{}")


class StoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(os.path.realpath(tempfile.mkdtemp(prefix="trip-store-")))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.base = self.work / "nfs"
        self.base.mkdir()
        self.trip = self.base / TRIP_ID
        for sub in ("trip", "server-data", "documents", "media"):
            (self.trip / sub).mkdir(parents=True)
        (self.trip / "TRIP.txt").write_text(f"trip: {SLUG}\ntrip_id: {TRIP_ID}\nslug: {SLUG}\n")
        self.store = TripStore(str(self.base), TRIP_ID, TRIP_ID)


class TripStoreWriteTests(StoreCase):
    def test_files_are_written_whole_into_trip_and_named_as_given(self) -> None:
        self.store.write_trip_files({"trip.config.json": b'{"a": 1}', "bookings.json": b"[]"})
        self.assertEqual(b'{"a": 1}', (self.trip / "trip" / "trip.config.json").read_bytes())
        self.assertEqual(b"[]", (self.trip / "trip" / "bookings.json").read_bytes())
        self.assertEqual([], [p.name for p in (self.trip / "trip").iterdir() if p.name.startswith(".")], "no temp files left")

    def test_a_file_is_replaced_and_takes_the_owner_of_trip(self) -> None:
        (self.trip / "trip" / "trip.config.json").write_text("old")
        self.store.write_trip_files({"trip.config.json": b"new"})
        written = (self.trip / "trip" / "trip.config.json")
        self.assertEqual(b"new", written.read_bytes())
        owner = os.stat(self.trip / "trip")
        self.assertEqual((owner.st_uid, owner.st_gid), (os.stat(written).st_uid, os.stat(written).st_gid))
        self.assertEqual(0o644, stat.S_IMODE(os.stat(written).st_mode))

    def test_a_symlink_where_a_file_goes_is_replaced_never_followed(self) -> None:
        elsewhere = self.work / "elsewhere"
        elsewhere.write_text("someone else's file")
        os.symlink(elsewhere, self.trip / "trip" / "trip.config.json")
        self.store.write_trip_files({"trip.config.json": b"mine"})
        self.assertEqual("someone else's file", elsewhere.read_text())
        self.assertFalse((self.trip / "trip" / "trip.config.json").is_symlink())
        self.assertEqual(b"mine", (self.trip / "trip" / "trip.config.json").read_bytes())

    def test_a_trip_directory_that_is_a_symlink_is_refused(self) -> None:
        other = self.base / "trip_ffffffffffffffffffffffffffffffff"
        shutil.copytree(self.trip, other, symlinks=True)
        shutil.rmtree(self.trip)
        os.symlink(other, self.trip)
        with self.assertRaisesRegex(TripStoreError, "not a real directory"):
            self.store.write_trip_files({"trip.config.json": b"x"})
        self.assertFalse((other / "trip" / "trip.config.json").exists())

    def test_a_trip_subdirectory_swapped_for_a_link_is_refused(self) -> None:
        victim = self.work / "victim"
        victim.mkdir()
        shutil.rmtree(self.trip / "trip")
        os.symlink(victim, self.trip / "trip")
        with self.assertRaisesRegex(TripStoreError, "not a real directory"):
            self.store.write_trip_files({"trip.config.json": b"x"})
        self.assertEqual([], list(victim.iterdir()))

    def test_a_directory_that_belongs_to_another_trip_is_refused(self) -> None:
        (self.trip / "TRIP.txt").write_text("trip: x\ntrip_id: trip_ffffffffffffffffffffffffffffffff\nslug: x\n")
        with self.assertRaisesRegex(TripStoreError, "another trip"):
            self.store.write_trip_files({"trip.config.json": b"x"})

    def test_an_absent_directory_is_never_made_here(self) -> None:
        shutil.rmtree(self.trip)
        with self.assertRaisesRegex(TripStoreError, "not on the document store the worker sees"):
            self.store.write_trip_files({"trip.config.json": b"x"})
        self.assertFalse(self.trip.exists())
        shutil.rmtree(self.base)
        with self.assertRaisesRegex(TripStoreError, "PROVISIONER_TRIP_NFS_LOCAL_BASE"):
            self.store.write_trip_files({"trip.config.json": b"x"})

    def test_an_absent_trip_subdirectory_is_never_made_here(self) -> None:
        shutil.rmtree(self.trip / "trip")
        with self.assertRaisesRegex(TripStoreError, "ensure has not run"):
            self.store.write_trip_files({"trip.config.json": b"x"})
        self.assertFalse((self.trip / "trip").exists())

    def test_a_directory_with_no_trip_txt_is_refused(self) -> None:
        (self.trip / "TRIP.txt").unlink()
        with self.assertRaisesRegex(TripStoreError, "no TRIP.txt"):
            self.store.write_trip_files({"trip.config.json": b"x"})

    def test_a_name_that_is_not_a_plain_file_name_is_refused(self) -> None:
        for name in ("../x", "a/b", ".hidden", "", "x" * 200):
            with self.subTest(name=name), self.assertRaisesRegex(TripStoreError, "file name"):
                self.store.write_trip_files({name: b"x"})

    def test_a_failed_hand_over_leaves_no_file_and_says_why(self) -> None:
        with mock.patch("os.fchown", side_effect=PermissionError()), \
                self.assertRaisesRegex(TripStoreError, "could not hand"):
            self.store.write_trip_files({"trip.config.json": b"x"})
        self.assertEqual([], list((self.trip / "trip").iterdir()))

    def test_read_back_returns_the_bytes_or_none(self) -> None:
        self.assertIsNone(self.store.read_trip_file("trip.config.json"))
        self.store.write_trip_files({"trip.config.json": b'{"x": 1}'})
        self.assertEqual(b'{"x": 1}', self.store.read_trip_file("trip.config.json"))

    def test_read_back_does_not_follow_a_link(self) -> None:
        secret = self.work / "secret"
        secret.write_text("not for you")
        os.symlink(secret, self.trip / "trip" / "trip.config.json")
        with self.assertRaisesRegex(TripStoreError, "not a plain file"):
            self.store.read_trip_file("trip.config.json")


class TripStoreResetTests(StoreCase):
    def test_it_removes_the_data_and_the_media_and_nothing_else(self) -> None:
        (self.trip / "server-data" / "trip.db").write_text("sqlite")
        (self.trip / "media" / "avatars").mkdir()
        (self.trip / "media" / "avatars" / "a.jpg").write_text("jpg")
        (self.trip / ".env").write_text("SEED_PASSWORD=x")
        (self.trip / "trip" / "trip.config.json").write_text("{}")
        (self.trip / "documents" / "d.pdf").write_text("pdf")
        self.store.reset_data()
        self.assertFalse((self.trip / "server-data").exists())
        self.assertFalse((self.trip / "media").exists())
        for kept in (".env", "TRIP.txt", "trip/trip.config.json", "documents/d.pdf"):
            self.assertTrue((self.trip / kept).exists(), kept)

    def test_a_link_in_its_place_is_removed_as_a_link_and_not_followed(self) -> None:
        victim = self.work / "victim"
        victim.mkdir()
        (victim / "precious").write_text("x")
        shutil.rmtree(self.trip / "server-data")
        os.symlink(victim, self.trip / "server-data")
        self.store.reset_data()
        self.assertFalse((self.trip / "server-data").is_symlink())
        self.assertTrue((victim / "precious").exists())

    def test_it_refuses_a_directory_that_is_not_this_trips(self) -> None:
        (self.trip / "TRIP.txt").write_text("trip: x\ntrip_id: trip_ffffffffffffffffffffffffffffffff\nslug: x\n")
        (self.trip / "server-data" / "trip.db").write_text("sqlite")
        with self.assertRaisesRegex(TripStoreError, "another trip"):
            self.store.reset_data()
        self.assertTrue((self.trip / "server-data" / "trip.db").exists())


class SmallHelpersTests(unittest.TestCase):
    def test_a_release_digest_becomes_the_bare_hex_and_nothing_else_does(self) -> None:
        self.assertEqual(DIGEST, image_digest("sha256:" + DIGEST))
        for bad in (None, "", DIGEST, "sha256:" + DIGEST[:-1], "sha256:" + DIGEST.upper(), "sha256:" + DIGEST + "\n",
                    "sha256:" + "0" * 64 + "; rm"):
            with self.subTest(bad=bad), self.assertRaises(ReleaseNotVerified) as caught:
                image_digest(bad)
            self.assertEqual("TRIP_CONTAINER_NEEDS_VERIFIED_RELEASE", caught.exception.safe_error_code)

    def test_the_ip_pool_is_plain_addresses_with_no_repeats(self) -> None:
        self.assertEqual(["10.250.0.10", "10.250.0.11"], validate_ip_pool(["10.250.0.10", "10.250.0.11"]))
        for bad in (["10.250.0.10", "10.250.0.10"], ["10.250.0.010"], ["nope"], [10], ["10.250.0.0/24"]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_ip_pool(bad)


if __name__ == "__main__":
    unittest.main()
